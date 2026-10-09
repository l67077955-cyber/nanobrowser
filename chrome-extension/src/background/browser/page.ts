import 'webextension-polyfill';
import {
  connect,
  ExtensionTransport,
  type HTTPRequest,
  type HTTPResponse,
  type ProtocolType,
  type KeyInput,
} from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import type { Browser } from 'puppeteer-core/lib/esm/puppeteer/api/Browser.js';
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { Frame } from 'puppeteer-core/lib/esm/puppeteer/api/Frame.js';
import {
  getClickableElements as _getClickableElements,
  removeHighlights as _removeHighlights,
  getScrollInfo as _getScrollInfo,
  getPageText as _getPageText,
  loadLazyContent,
} from './dom/service';
import { findThroughShadowRoots } from './dom/shadowPath';
import { AGENT_MARK_ID, drawAgentMark, removeAgentMark, setAgentMarkVisible } from './agentMark';
import { DOMElementNode, type DOMState } from './dom/views';
import {
  type BrowserContextConfig,
  DEFAULT_BROWSER_CONTEXT_CONFIG,
  ElementChangedError,
  ElementNotFoundError,
  type PageState,
  URLNotAllowedError,
} from './views';
import { createLogger } from '@src/background/log';
import { ClickableElementProcessor } from './dom/clickable/service';
import { isPageStateOutdated, isUrlAllowed } from './util';

const logger = createLogger('Page');

// Attributes that say what an element is; if one differs at action time, the locator found a different element.
// ids are left out because many sites regenerate them on every render.
const CLICK_TIMEOUT = 'Click timeout';
// The default waits for the load event, which one stalled image or script holds back for the full 30 s
// while the page is already usable. The DOM is enough; waitForPageAndFramesLoad waits for the rest, with a cap.
const NAVIGATION_WAIT = { waitUntil: 'domcontentloaded' } as const;
const PRESSED_FLAG = '__nanobrowserPressed';
// the longest the model waits for a screenshot: a tab not in front may never be painted
const SCREENSHOT_TIMEOUT_MS = 5000;

// What sites call their captcha image in its id, class, alt, title or address
const CAPTCHA_HINT = 'captcha|kaptcha|verif|valid|v_?code|check_?code|auth_?code|img_?code|rand|yzm|验证码';
// enlarged to about this height: small coloured or thin characters are misread at their own size
const CAPTCHA_TARGET_HEIGHT = 160;

/** @returns true when a base64 PNG is a single colour; false when that cannot be told here */
async function isBlankPng(base64: string): Promise<boolean> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return false;
  try {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    for (let i = 4; i < pixels.length; i += 4) {
      if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const IDENTITY_ATTRIBUTES = ['role', 'type', 'name', 'aria-label', 'data-testid', 'placeholder', 'href'];

const collapseLabel = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
};

export function build_initial_state(tabId?: number, url?: string, title?: string): PageState {
  return {
    elementTree: new DOMElementNode({
      tagName: 'root',
      isVisible: true,
      parent: null,
      xpath: '',
      attributes: {},
      children: [],
    }),
    selectorMap: new Map(),
    tabId: tabId || 0,
    url: url || '',
    title: title || '',
    screenshot: null,
    scrollY: 0,
    scrollHeight: 0,
    visualViewportHeight: 0,
  };
}

/**
 * Cached clickable elements hashes for the last state
 */
export class CachedStateClickableElementsHashes {
  url: string;
  hashes: Set<string>;

  constructor(url: string, hashes: Set<string>) {
    this.url = url;
    this.hashes = hashes;
  }
}

export default class Page {
  private _tabId: number;
  private _browser: Browser | null = null;
  private _puppeteerPage: PuppeteerPage | null = null;
  private _config: BrowserContextConfig;
  private _state: PageState;
  private _validWebPage = false;
  private _cachedState: PageState | null = null;
  private _cachedStateClickableElementsHashes: CachedStateClickableElementsHashes | null = null;

  constructor(tabId: number, url: string, title: string, config: Partial<BrowserContextConfig> = {}) {
    this._tabId = tabId;
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
    this._state = build_initial_state(tabId, url, title);
    // chrome://newtab/, chrome://newtab/extensions, https://chromewebstore.google.com/ are not valid web pages, can't be attached
    const lowerCaseUrl = url.trim().toLowerCase();
    this._validWebPage =
      (tabId &&
        lowerCaseUrl &&
        lowerCaseUrl.startsWith('http') &&
        !lowerCaseUrl.startsWith('https://chromewebstore.google.com')) ||
      false;
  }

  get tabId(): number {
    return this._tabId;
  }

  get validWebPage(): boolean {
    return this._validWebPage;
  }

  get attached(): boolean {
    return this._validWebPage && this._puppeteerPage !== null;
  }

  async attachPuppeteer(): Promise<boolean> {
    if (!this._validWebPage) {
      return false;
    }

    if (this._puppeteerPage) {
      return true;
    }

    logger.info('attaching puppeteer', this._tabId);
    const browser = await connect({
      transport: await ExtensionTransport.connectTab(this._tabId),
      defaultViewport: null,
      protocol: 'cdp' as ProtocolType,
    });
    this._browser = browser;

    const [page] = await browser.pages();
    this._puppeteerPage = page;

    // Add anti-detection scripts
    await this._addAntiDetectionScripts();

    return true;
  }

  /**
   * Chrome freezes a tab that has been hidden for a while: its scripts then never answer, and every read of it
   * waited out its timeouts, a minute a step, until the tab woke on its own. The agent works in tabs behind the
   * user's, so each read wakes the tab first.
   */
  private async wake(): Promise<void> {
    await chrome.debugger
      .sendCommand({ tabId: this._tabId }, 'Page.setWebLifecycleState', { state: 'active' })
      .catch(error => logger.debug('Could not wake the tab:', error));
  }

  private async _addAntiDetectionScripts(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    await this._puppeteerPage.evaluateOnNewDocument(`
      // Webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // Languages
      // Object.defineProperty(navigator, 'languages', {
      //   get: () => ['en-US']
      // });

      // Plugins
      // Object.defineProperty(navigator, 'plugins', {
      //   get: () => [1, 2, 3, 4, 5]
      // });

      // Chrome runtime
      window.chrome = { runtime: {} };

      // Permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Shadow DOM
      (function () {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function attachShadow(options) {
          return originalAttachShadow.call(this, { ...options, mode: "open" });
        };
      })();
    `);
  }

  async detachPuppeteer(): Promise<void> {
    if (this._browser) {
      await this._browser.disconnect();
      this._browser = null;
      this._puppeteerPage = null;
      // reset the state
      this._state = build_initial_state(this._tabId);
    }
  }

  async removeHighlight(): Promise<void> {
    if (this._config.displayHighlights && this._validWebPage) {
      await _removeHighlights(this._tabId);
    }
  }

  /** Shows the user, on the page, the element the agent is about to act on (see agentMark.ts) */
  private async markAgentTarget(element: ElementHandle, verb: string, elementNode: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) return;
    try {
      const label = elementNode.highlightIndex != null ? `${verb} [${elementNode.highlightIndex}]` : verb;
      const box = await element.boundingBox();
      await this._puppeteerPage.evaluate(drawAgentMark, AGENT_MARK_ID, label, box);
    } catch (error) {
      // only a hint for the user: the action goes on without it
      logger.debug('Failed to mark the element acted on:', error);
    }
  }

  /** Takes the agent's mark off the page, when the task is over */
  async clearAgentMark(): Promise<void> {
    if (!this._puppeteerPage || !this._validWebPage) return;
    await this._puppeteerPage.evaluate(removeAgentMark, AGENT_MARK_ID).catch(() => {});
  }

  async getClickableElements(showHighlightElements: boolean, focusElement: number): Promise<DOMState | null> {
    if (!this._validWebPage) {
      return null;
    }
    return _getClickableElements(
      this._tabId,
      this.url(),
      showHighlightElements,
      focusElement,
      this._config.viewportExpansion,
    );
  }

  // Get scroll position information for the current page.
  async getScrollInfo(): Promise<[number, number, number]> {
    if (!this._validWebPage) {
      return [0, 0, 0];
    }
    return _getScrollInfo(this._tabId);
  }

  /** The readable text of the whole page, not only the part in view */
  async getPageText(loadLazy = false): Promise<{ title: string; url: string; text: string }> {
    if (!this._validWebPage) {
      return { title: '', url: '', text: '' };
    }
    await this.wake();
    if (loadLazy) {
      // a page that has not loaded everything yet still has some text to give
      await loadLazyContent(this._tabId).catch(error => logger.warning('Could not scroll the page through', error));
    }
    return _getPageText(this._tabId);
  }

  // Get scroll position information for a specific element.
  async getElementScrollInfo(elementNode: DOMElementNode): Promise<[number, number, number]> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    const element = await this.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    // Find the nearest scrollable ancestor
    const scrollableElement = await this._findNearestScrollableElement(element);
    if (!scrollableElement) {
      throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
    }

    const scrollInfo = await scrollableElement.evaluate(el => {
      return {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      };
    });

    return [scrollInfo.scrollTop, scrollInfo.clientHeight, scrollInfo.scrollHeight];
  }

  /**
   * Find the nearest scrollable ancestor of the given element
   * @param element The element to start searching from
   * @returns The nearest scrollable ancestor or null if none found
   */
  private async _findNearestScrollableElement(element: ElementHandle): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      return null;
    }

    // Check if the current element is scrollable
    const isScrollable = await element.evaluate((el: Element) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
      const canScrollVertically =
        style.overflowY === 'scroll' ||
        style.overflowY === 'auto' ||
        style.overflow === 'scroll' ||
        style.overflow === 'auto';

      return hasVerticalScrollbar && canScrollVertically;
    });

    if (isScrollable) {
      return element;
    }

    // Check parent elements
    let currentElement: ElementHandle<Element> | null = element;

    try {
      while (currentElement) {
        // Get the parent element (as an ElementHandle) of the current element
        const parentHandle = (await currentElement.evaluateHandle(
          (el: Element) => el.parentElement,
        )) as ElementHandle<Element> | null;

        const parentElement = parentHandle ? await parentHandle.asElement() : null;

        if (!parentElement) {
          // Reached the root without finding a scrollable ancestor
          currentElement = null;
          break;
        }

        const parentIsScrollable = await parentElement.evaluate((el: Element) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
          const canScrollVertically =
            ['scroll', 'auto'].includes(style.overflowY) || ['scroll', 'auto'].includes(style.overflow);

          return hasVerticalScrollbar && canScrollVertically;
        });

        if (parentIsScrollable) {
          // Found a scrollable ancestor – return it (the caller should dispose when finished)
          return parentElement;
        }

        // Move up the DOM tree – dispose the previous element handle before continuing
        if (currentElement !== element) {
          try {
            await currentElement.dispose();
          } catch (disposeErr) {
            logger.debug('Failed to dispose element handle:', disposeErr);
          }
        }

        currentElement = parentElement;
      }
    } catch (error) {
      // Error accessing parent, break out of loop
      logger.error('Error finding scrollable parent:', error);
    }

    // If no scrollable ancestor found, return the document body or documentElement
    try {
      const bodyElement = await this._puppeteerPage.$('body');
      if (bodyElement) {
        const bodyIsScrollable = await bodyElement.evaluate(el => {
          if (!(el instanceof HTMLElement)) return false;
          return el.scrollHeight > el.clientHeight;
        });
        if (bodyIsScrollable) {
          return bodyElement;
        }
      }

      // Last resort: return document element for page-level scrolling
      const documentElement = await this._puppeteerPage.evaluateHandle(() => document.documentElement);
      const docElement = (await documentElement.asElement()) as ElementHandle<Element> | null;
      return docElement;
    } catch (error) {
      logger.error('Failed to find scrollable element:', error);
      return null;
    }
  }

  async getContent(): Promise<string> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }
    return await this._puppeteerPage.content();
  }

  getCachedState(): PageState | null {
    return this._cachedState;
  }

  async getState(useVision = false, cacheClickableElementsHashes = false): Promise<PageState> {
    if (!this._validWebPage) {
      // return the initial state
      return build_initial_state(this._tabId);
    }
    await this.waitForPageAndFramesLoad();
    const updatedState = await this._updateState(useVision);

    // Find out which elements are new
    // Do this only if url has not changed
    if (cacheClickableElementsHashes) {
      // If we are on the same url as the last state, we can use the cached hashes
      if (
        this._cachedStateClickableElementsHashes &&
        this._cachedStateClickableElementsHashes.url === updatedState.url
      ) {
        // Get clickable elements from the updated state
        const updatedStateClickableElements = ClickableElementProcessor.getClickableElements(updatedState.elementTree);

        // Mark elements as new if they weren't in the previous state
        for (const domElement of updatedStateClickableElements) {
          const hash = await ClickableElementProcessor.hashDomElement(domElement);
          domElement.isNew = !this._cachedStateClickableElementsHashes.hashes.has(hash);
        }
      }

      // In any case, we need to cache the new hashes
      const newHashes = await ClickableElementProcessor.getClickableElementsHashes(updatedState.elementTree);
      this._cachedStateClickableElementsHashes = new CachedStateClickableElementsHashes(updatedState.url, newHashes);
    }

    // Save the updated state as the cached state
    this._cachedState = updatedState;

    return updatedState;
  }

  async _updateState(useVision = false, focusElement = -1): Promise<PageState> {
    try {
      // Test if page is still accessible
      // @ts-expect-error - puppeteerPage is not null, already checked before calling this function
      await this._puppeteerPage.evaluate('1');
    } catch (error) {
      logger.warning('Current page is no longer accessible:', error);
      if (this._browser) {
        const pages = await this._browser.pages();
        if (pages.length > 0) {
          this._puppeteerPage = pages[0];
        } else {
          throw new Error('Browser closed: no valid pages available');
        }
      }
    }

    try {
      await this.wake();
      await this.removeHighlight();

      // Get DOM content (equivalent to dom_service.get_clickable_elements)
      // This part would need to be implemented based on your DomService logic
      // showHighlightElements is true if either useVision or displayHighlights is true
      const displayHighlights = this._config.displayHighlights || useVision;
      const content = await this.getClickableElements(displayHighlights, focusElement);
      if (!content) {
        logger.warning('Failed to get clickable elements');
        // Return last known good state if available
        return this._state;
      }
      // log the attributes of content object
      if ('selectorMap' in content) {
        logger.debug('content.selectorMap:', content.selectorMap.size);
      } else {
        logger.debug('content.selectorMap: not found');
      }
      if ('elementTree' in content) {
        logger.debug('content.elementTree:', content.elementTree?.tagName);
      } else {
        logger.debug('content.elementTree: not found');
      }

      // Take screenshot if needed
      const screenshot = useVision ? await this.screenshotWithoutMark() : null;
      const [scrollY, visualViewportHeight, scrollHeight] = await this.getScrollInfo();

      // update the state
      this._state.elementTree = content.elementTree;
      this._state.selectorMap = content.selectorMap;
      this._state.url = this._puppeteerPage?.url() || '';
      this._state.title = (await this._puppeteerPage?.title()) || '';
      this._state.screenshot = screenshot;
      this._state.scrollY = scrollY;
      this._state.visualViewportHeight = visualViewportHeight;
      this._state.scrollHeight = scrollHeight;
      this._state.unreadable = false;
      return this._state;
    } catch (error) {
      logger.error('Failed to update state:', error);
      // The last state is of a page that is gone once the tab has moved on, e.g. to the browser's error page
      // after a failed load, where no script runs. Handing it back made the agent click on a page that was
      // no longer there, step after step.
      const tab = await chrome.tabs.get(this._tabId).catch(() => null);
      if (tab && isPageStateOutdated(this._state.url, tab.url ?? '', this._puppeteerPage?.url() ?? '')) {
        logger.warning(`Tab ${this._tabId} now shows ${tab.url}, which could not be read`);
        this._state = { ...build_initial_state(this._tabId, tab.url, tab.title), unreadable: true };
      }
      // Otherwise return last known good state
      return this._state;
    }
  }

  /** A screenshot for the model, without the agent's own mark over the page */
  private async screenshotWithoutMark(): Promise<string | null> {
    const page = this._puppeteerPage;
    await page?.evaluate(setAgentMarkVisible, AGENT_MARK_ID, false).catch(() => {});
    try {
      // a tab behind the one in front may not be painted, and its screenshot may never come: the model then
      // works from the page's text, rather than the tab being brought to the front over the user's
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), SCREENSHOT_TIMEOUT_MS);
      });
      const screenshot = await Promise.race([this.takeScreenshot().catch(() => null), timedOut]);
      clearTimeout(timer);
      if (screenshot === null) logger.warning(`No screenshot of tab ${this._tabId}, going on with the page text`);
      return screenshot;
    } finally {
      await page?.evaluate(setAgentMarkVisible, AGENT_MARK_ID, true).catch(() => {});
    }
  }

  async takeScreenshot(fullPage = false): Promise<string | null> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    try {
      // First disable animations/transitions
      await this._puppeteerPage.evaluate(() => {
        const styleId = 'puppeteer-disable-animations';
        if (!document.getElementById(styleId)) {
          const style = document.createElement('style');
          style.id = styleId;
          style.textContent = `
            *, *::before, *::after {
              animation: none !important;
              transition: none !important;
            }
          `;
          document.head.appendChild(style);
        }
      });

      // Take the screenshot using JPEG format with 80% quality
      const screenshot = await this._puppeteerPage.screenshot({
        fullPage: fullPage,
        encoding: 'base64',
        type: 'jpeg',
        quality: 80, // Good balance between quality and file size
      });

      // Clean up the style element
      await this._puppeteerPage.evaluate(() => {
        const style = document.getElementById('puppeteer-disable-animations');
        if (style) {
          style.remove();
        }
      });

      return screenshot as string;
    } catch (error) {
      logger.error('Failed to take screenshot:', error);
      throw error;
    }
  }

  url(): string {
    if (this._puppeteerPage) {
      return this._puppeteerPage.url();
    }
    return this._state.url;
  }

  async title(): Promise<string> {
    if (this._puppeteerPage) {
      return await this._puppeteerPage.title();
    }
    return this._state.title;
  }

  async navigateTo(url: string): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }
    logger.info('navigateTo', url);

    // Check if URL is allowed
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goto(url, NAVIGATION_WAIT)]);
      logger.info('navigateTo complete');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning(`Navigation timeout, but page might still be usable: ${error.message}`);
        return;
      }

      logger.error('Navigation failed:', error);
      throw error;
    }
  }

  async refreshPage(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.reload(NAVIGATION_WAIT)]);
      logger.info('Page refresh complete');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Refresh timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Page refresh failed:', error);
      throw error;
    }
  }

  async goBack(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goBack(NAVIGATION_WAIT)]);
      logger.info('Navigation back completed');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Back navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Could not navigate back:', error);
      throw error;
    }
  }

  async goForward(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goForward(NAVIGATION_WAIT)]);
      logger.info('Navigation forward completed');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Forward navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Could not navigate forward:', error);
      throw error;
    }
  }

  /**
   * Scroll the open dialog instead of the page behind it: a modal (a plan table, a settings box) scrolls
   * inside its own box, so scrolling the window changes nothing. Null when no open dialog can scroll.
   */
  async scrollOpenDialog(how: { percent: number } | { pages: number }): Promise<{ moved: boolean } | null> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    return this._puppeteerPage.evaluate(how => {
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const dialogs = Array.from(
        document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'),
      ).filter(visible);
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return null;
      const scrolls = (el: Element) =>
        /^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 4;
      const boxes = [dialog, ...Array.from(dialog.querySelectorAll('*'))].filter(el => scrolls(el) && visible(el));
      if (!boxes.length) return null;
      const box = boxes.reduce((a, b) => (b.clientHeight * b.clientWidth > a.clientHeight * a.clientWidth ? b : a));
      const max = box.scrollHeight - box.clientHeight;
      const before = box.scrollTop;
      const top = 'percent' in how ? (max * how.percent) / 100 : before + how.pages * box.clientHeight;
      box.scrollTo({ top: Math.max(0, Math.min(max, top)), behavior: 'instant' });
      return { moved: Math.abs(box.scrollTop - before) > 1 };
    }, how);
  }

  // scroll to a percentage of the page or element
  // if yPercent is 0, scroll to the top of the page, if 100, scroll to the bottom of the page
  // if elementNode is provided, scroll to a percentage of the element
  // if elementNode is not provided, scroll to a percentage of the page
  async scrollToPercent(yPercent: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      await this._puppeteerPage.evaluate(yPercent => {
        const scrollHeight = document.documentElement.scrollHeight;
        const viewportHeight = window.visualViewport?.height || window.innerHeight;
        const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
        window.scrollTo({
          top: scrollTop,
          left: window.scrollX,
          behavior: 'smooth',
        });
      }, yPercent);
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate((el, yPercent) => {
        const scrollHeight = el.scrollHeight;
        const viewportHeight = el.clientHeight;
        const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
        el.scrollTo({
          top: scrollTop,
          left: el.scrollLeft,
          behavior: 'smooth',
        });
      }, yPercent);
    }
  }

  async scrollBy(y: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      await this._puppeteerPage.evaluate(y => {
        window.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      }, y);
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }
      await scrollableElement.evaluate(el => {
        el.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      });
    }
  }

  async scrollToPreviousPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      // Scroll the whole page up by viewport height
      await this._puppeteerPage.evaluate('window.scrollBy(0, -(window.visualViewport?.height || window.innerHeight));');
    } else {
      // Scroll the specific element up by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, -el.clientHeight);
      });
    }
  }

  async scrollToNextPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      // Scroll the whole page down by viewport height
      await this._puppeteerPage.evaluate('window.scrollBy(0, (window.visualViewport?.height || window.innerHeight));');
    } else {
      // Scroll the specific element down by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, el.clientHeight);
      });
    }
  }

  async sendKeys(keys: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    // Split combination keys (e.g., "Control+A" or "Shift+ArrowLeft")
    const keyParts = keys.split('+');
    const modifiers = keyParts.slice(0, -1);
    const mainKey = keyParts[keyParts.length - 1];

    // Press modifiers and main key, ensure modifiers are released even if an error occurs.
    try {
      // Press all modifier keys (e.g., Control, Shift, etc.)
      for (const modifier of modifiers) {
        await this._puppeteerPage.keyboard.down(this._convertKey(modifier));
      }
      // Press the main key
      // also wait for stable state
      await Promise.all([
        this._puppeteerPage.keyboard.press(this._convertKey(mainKey)),
        this.waitForPageAndFramesLoad(),
      ]);
      logger.info('sendKeys complete', keys);
    } catch (error) {
      logger.error('Failed to send keys:', error);
      throw new Error(`Failed to send keys: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Release all modifier keys in reverse order regardless of any errors in key press.
      for (const modifier of [...modifiers].reverse()) {
        try {
          await this._puppeteerPage.keyboard.up(this._convertKey(modifier));
        } catch (releaseError) {
          logger.error('Failed to release modifier:', modifier, releaseError);
        }
      }
    }
  }

  private _convertKey(key: string): KeyInput {
    const lowerKey = key.trim().toLowerCase();
    const isMac = navigator.userAgent.toLowerCase().includes('mac os x');

    if (isMac) {
      if (lowerKey === 'control' || lowerKey === 'ctrl') {
        return 'Meta' as KeyInput; // Use Command key on Mac
      }
      if (lowerKey === 'command' || lowerKey === 'cmd') {
        return 'Meta' as KeyInput; // Map Command/Cmd to Meta on Mac
      }
      if (lowerKey === 'option' || lowerKey === 'opt') {
        return 'Alt' as KeyInput; // Map Option/Opt to Alt on Mac
      }
    }

    const keyMap: { [key: string]: string } = {
      // Letters
      a: 'KeyA',
      b: 'KeyB',
      c: 'KeyC',
      d: 'KeyD',
      e: 'KeyE',
      f: 'KeyF',
      g: 'KeyG',
      h: 'KeyH',
      i: 'KeyI',
      j: 'KeyJ',
      k: 'KeyK',
      l: 'KeyL',
      m: 'KeyM',
      n: 'KeyN',
      o: 'KeyO',
      p: 'KeyP',
      q: 'KeyQ',
      r: 'KeyR',
      s: 'KeyS',
      t: 'KeyT',
      u: 'KeyU',
      v: 'KeyV',
      w: 'KeyW',
      x: 'KeyX',
      y: 'KeyY',
      z: 'KeyZ',

      // Numbers
      '0': 'Digit0',
      '1': 'Digit1',
      '2': 'Digit2',
      '3': 'Digit3',
      '4': 'Digit4',
      '5': 'Digit5',
      '6': 'Digit6',
      '7': 'Digit7',
      '8': 'Digit8',
      '9': 'Digit9',

      // Special keys
      control: 'Control',
      shift: 'Shift',
      alt: 'Alt',
      meta: 'Meta',
      enter: 'Enter',
      backspace: 'Backspace',
      delete: 'Delete',
      arrowleft: 'ArrowLeft',
      arrowright: 'ArrowRight',
      arrowup: 'ArrowUp',
      arrowdown: 'ArrowDown',
      escape: 'Escape',
      tab: 'Tab',
      space: 'Space',
    };

    const convertedKey = keyMap[lowerKey] || key;
    logger.info('convertedKey', convertedKey);
    return convertedKey as KeyInput;
  }

  async scrollToText(text: string, nth: number = 1): Promise<boolean> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Convert text to lowercase for consistent searching
      const lowerCaseText = text.toLowerCase();

      // Try different locator strategies to find all elements containing the text
      const selectors = [
        // Using text selector (equivalent to get_by_text) - for exact text match
        `::-p-text(${text})`,
        // Using XPath selector (contains text) - case insensitive
        `::-p-xpath(//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerCaseText}')])`,
      ];

      for (const selector of selectors) {
        try {
          // Use $$ to get all matching elements
          const elements = await this._puppeteerPage.$$(selector);

          if (elements.length > 0) {
            // Find visible elements and select the nth occurrence
            const visibleElements = [];

            for (const element of elements) {
              const isVisible = await element.evaluate(el => {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return (
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.opacity !== '0' &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              });

              if (isVisible) {
                visibleElements.push(element);
              }
            }

            // Check if we have enough visible elements for the requested nth occurrence
            if (visibleElements.length >= nth) {
              const targetElement = visibleElements[nth - 1]; // Convert to 0-indexed
              await this._scrollIntoViewIfNeeded(targetElement);
              await new Promise(resolve => setTimeout(resolve, 500)); // Wait for scroll to complete

              // Dispose of all element handles to prevent memory leaks
              for (const element of elements) {
                await element.dispose();
              }

              return true;
            }
          }

          // Dispose of all element handles to prevent memory leaks
          for (const element of elements) {
            await element.dispose();
          }
        } catch (e) {
          logger.debug(`Locator attempt failed: ${e}`);
        }
      }
      return false;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async getDropdownOptions(element: DOMElementNode): Promise<Array<{ index: number; text: string; value: string }>> {
    if (!this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error('Dropdown element not found');
      }
      await this.assertSameElement(elementHandle, element);

      // Evaluate the select element to get all options
      const options = await elementHandle.evaluate(select => {
        if (!(select instanceof HTMLSelectElement)) {
          throw new Error('Element is not a select element');
        }

        return Array.from(select.options).map(option => ({
          index: option.index,
          text: option.text, // Not trimming to maintain exact match for selection
          value: option.value,
        }));
      });

      if (!options.length) {
        throw new Error('No options found in dropdown');
      }

      return options;
    } catch (error) {
      throw new Error(`Failed to get dropdown options: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async selectDropdownOption(element: DOMElementNode, text: string): Promise<string> {
    const index = element.highlightIndex;
    if (!this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    logger.debug(`Attempting to select '${text}' from dropdown`);
    logger.debug(`Element attributes: ${JSON.stringify(element.attributes)}`);
    logger.debug(`Element tag: ${element.tagName}`);

    // Validate that we're working with a select element
    if (element.tagName?.toLowerCase() !== 'select') {
      const msg = `Cannot select option: Element with index ${index} is a ${element.tagName}, not a SELECT`;
      logger.error(msg);
      throw new Error(msg);
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error(`Dropdown element with index ${index} not found`);
      }
      await this.assertSameElement(elementHandle, element);
      await this.markAgentTarget(elementHandle, 'select', element);

      // Verify dropdown and select option in one call
      const result = await elementHandle.evaluate(
        (select, optionText, elementIndex) => {
          if (!(select instanceof HTMLSelectElement)) {
            return {
              found: false,
              message: `Element with index ${elementIndex} is not a SELECT`,
            };
          }

          const options = Array.from(select.options);
          const option = options.find(opt => opt.text.trim() === optionText);

          if (!option) {
            const availableOptions = options.map(o => o.text.trim()).join('", "');
            return {
              found: false,
              message: `Option "${optionText}" not found in dropdown element with index ${elementIndex}. Available options: "${availableOptions}"`,
            };
          }

          // Set the value and dispatch events
          const previousValue = select.value;
          select.value = option.value;

          // Only dispatch events if the value actually changed
          if (previousValue !== option.value) {
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
          }

          return {
            found: true,
            message: `Selected option "${optionText}" with value "${option.value}"`,
          };
        },
        text,
        index,
      );

      logger.debug('Selection result:', result);
      // whether found or not, return the message
      return result.message;
    } catch (error) {
      const errorMessage = `${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  /**
   * Find an element below shadow hosts by following its path down from host to host: selectors do not
   * reach into shadow roots. Each path starts at the document or at the shadow root of a host above it.
   */
  private async locateThroughShadowRoots(
    frame: PuppeteerPage | Frame,
    hosts: DOMElementNode[],
    element: DOMElementNode,
  ): Promise<ElementHandle | null> {
    const found = await frame.evaluateHandle(findThroughShadowRoots, [
      ...hosts.map(host => host.xpath ?? ''),
      element.xpath ?? '',
    ]);
    const handle = found.asElement() as ElementHandle | null;
    if (!handle) await found.dispose();
    return handle;
  }

  async locateElement(element: DOMElementNode): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      // throw new Error('Puppeteer page is not connected');
      logger.warning('Puppeteer is not connected');
      return null;
    }
    let currentFrame: PuppeteerPage | Frame = this._puppeteerPage;

    // Start with the target element and collect all parents
    const parents: DOMElementNode[] = [];
    let current = element;
    while (current.parent) {
      parents.push(current.parent);
      current = current.parent;
    }

    // Process all iframe parents in sequence (in reverse order - top to bottom)
    const iframes = parents.reverse().filter(item => item.tagName === 'iframe');
    for (const parent of iframes) {
      const cssSelector = parent.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);
      const frameElement: ElementHandle | null = await currentFrame.$(cssSelector);
      if (!frameElement) {
        // throw new Error(`Could not find iframe with selector: ${cssSelector}`);
        logger.warning(`Could not find iframe with selector: ${cssSelector}`);
        return null;
      }
      const frame: Frame | null = await frameElement.contentFrame();
      if (!frame) {
        // throw new Error(`Could not access frame content for selector: ${cssSelector}`);
        logger.warning(`Could not access frame content for selector: ${cssSelector}`);
        return null;
      }
      currentFrame = frame;
      logger.info('currentFrame changed', currentFrame);
    }

    const cssSelector = element.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);
    // shadow hosts below the last iframe: a path inside one is relative to its shadow root
    const hosts = parents.slice(parents.lastIndexOf(iframes[iframes.length - 1]) + 1).filter(p => p.shadowRoot);

    try {
      // Inside shadow roots a selector would match from the wrong root, so the path is followed first
      let elementHandle: ElementHandle | null =
        hosts.length > 0 && element.xpath ? await this.locateThroughShadowRoots(currentFrame, hosts, element) : null;

      // Try CSS selector
      if (!elementHandle) elementHandle = await currentFrame.$(cssSelector);

      // If CSS selector failed, try XPath
      if (!elementHandle) {
        const xpath = element.xpath;
        if (xpath) {
          try {
            logger.info('Trying XPath selector:', xpath);
            const fullXpath = xpath.startsWith('/') ? xpath : `/${xpath}`;
            const xpathSelector = `::-p-xpath(${fullXpath})`;
            elementHandle = await currentFrame.$(xpathSelector);
          } catch (xpathError) {
            logger.error('Failed to locate element using XPath:', xpathError);
          }
        }
      }

      // If element found, check visibility and scroll into view
      if (elementHandle) {
        const isHidden = await elementHandle.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(elementHandle);
        }
        return elementHandle;
      }

      logger.info('elementHandle not located');
    } catch (error) {
      logger.error('Failed to locate element:', error);
    }

    return null;
  }

  /**
   * A picture of the captcha that belongs to a field, as the user sees it (base64 PNG), with the text next to it. It is taken from the
   * screen, not from the image's address: fetching that again would make the site issue a different captcha.
   * @param imageNode the captcha image when the model saw it as an element; else it is looked for beside the field
   * @param refresh click the picture first, which makes most sites draw a new captcha
   */
  async captureCaptchaImage(
    fieldNode: DOMElementNode,
    imageNode?: DOMElementNode,
    refresh = false,
  ): Promise<{ image: string; textAround: string }> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    const anchor = await this.locateElement(imageNode ?? fieldNode);
    if (!anchor) {
      throw new Error(`Element: ${imageNode ?? fieldNode} not found`);
    }

    const found = await anchor.evaluateHandle(
      (el, isImage, hintSource) => {
        const hint = new RegExp(hintSource, 'i');
        // sized like a captcha: larger than an icon, smaller than a banner
        const fits = (candidate: Element) => {
          const rect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return (
            rect.width >= 40 &&
            rect.width <= 400 &&
            rect.height >= 16 &&
            rect.height <= 200 &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
          );
        };
        const pictures = (scope: Element) => Array.from(scope.querySelectorAll('img, canvas, svg')).filter(fits);
        if (isImage) {
          // the indexed element is the picture, or the clickable box around it
          return el.matches('img, canvas, svg') ? el : (pictures(el)[0] ?? el);
        }

        const center = (candidate: Element) => {
          const rect = candidate.getBoundingClientRect();
          return [rect.left + rect.width / 2, rect.top + rect.height / 2];
        };
        const [fieldX, fieldY] = center(el);
        const distance = (candidate: Element) => {
          const [x, y] = center(candidate);
          return Math.hypot(x - fieldX, y - fieldY);
        };
        const hinted = (candidate: Element) => {
          const src = candidate.getAttribute('src') ?? '';
          return hint.test(
            [
              candidate.id,
              candidate.getAttribute('class'),
              candidate.getAttribute('alt'),
              candidate.getAttribute('title'),
              src.startsWith('data:') ? '' : src,
            ].join(' '),
          );
        };
        // The captcha sits in the same row or group as its field: widen the search one ancestor at a time and
        // stop at the first level that has a candidate, so a logo elsewhere in the form is not taken for it.
        let scope = el.parentElement;
        for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
          const near = pictures(scope).filter(candidate => distance(candidate) <= 600);
          if (near.length > 0) {
            return near.sort((a, b) => Number(hinted(b)) - Number(hinted(a)) || distance(a) - distance(b))[0];
          }
        }
        return null;
      },
      imageNode !== undefined,
      CAPTCHA_HINT,
    );
    const image = found.asElement() as ElementHandle | null;
    if (!image) {
      throw new Error('no captcha image found beside the field');
    }

    if (refresh) {
      // listen before clicking: the new picture may arrive faster than a second call would
      const redrawn = image
        .evaluate(
          el =>
            new Promise<void>(resolve => {
              const isImg = el instanceof HTMLImageElement;
              if (isImg) el.addEventListener('load', () => resolve(), { once: true });
              setTimeout(resolve, isImg ? 3000 : 800);
            }),
        )
        .catch(() => undefined);
      await image.click();
      await redrawn;
    }

    // an image that is still loading would be read as blank
    await image
      .evaluate(async el => {
        if (!(el instanceof HTMLImageElement) || el.complete) return;
        await new Promise(resolve => {
          el.addEventListener('load', resolve, { once: true });
          el.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 3000);
        });
      })
      .catch(() => undefined);
    await this._scrollIntoViewIfNeeded(image);

    const box = await image.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      throw new Error('the captcha image is not visible');
    }
    const [pageLeft, pageTop] = await this._puppeteerPage.evaluate(() => [
      window.visualViewport?.pageLeft ?? window.scrollX,
      window.visualViewport?.pageTop ?? window.scrollY,
    ]);
    const scale = Math.min(4, Math.max(1, Math.round(CAPTCHA_TARGET_HEIGHT / box.height)));
    // which element was taken, and the text around it: a colour instruction may live outside the picture
    const described = await image
      .evaluate(el => {
        const src = el.getAttribute('src') ?? '';
        // the nearest group around the picture that has any text, a few levels up at most
        let around = '';
        for (let scope = el.parentElement, depth = 0; scope && depth < 4 && !around; depth++) {
          const text = (scope.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (text.length > 300) break;
          around = text;
          scope = scope.parentElement;
        }
        return {
          element: `<${el.tagName.toLowerCase()} id="${el.id}" class="${el.getAttribute('class') ?? ''}">`,
          src: src.length > 120 ? `${src.slice(0, 120)}…` : src,
          natural: el instanceof HTMLImageElement ? `${el.naturalWidth}x${el.naturalHeight}` : '',
          textAround: around.slice(0, 200),
        };
      })
      .catch(() => null);
    logger.info('[captcha] image', {
      ...described,
      box: `${Math.round(box.width)}x${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}`,
      scale,
      refresh,
      byImageIndex: imageNode !== undefined,
    });

    // The picture's own pixels, copied in the page: a screenshot comes out blank when the tab is not being painted,
    // as in a window that is hidden or covered. A picture from another site cannot be copied and is taken from
    // the screen instead.
    const copied = await image
      .evaluate((el, targetHeight) => {
        try {
          const source =
            el instanceof HTMLImageElement && el.naturalWidth > 0
              ? { picture: el, width: el.naturalWidth, height: el.naturalHeight }
              : el instanceof HTMLCanvasElement
                ? { picture: el, width: el.width, height: el.height }
                : null;
          if (!source) return { error: `a <${el.tagName.toLowerCase()}> that is not a loaded picture` };
          const zoom = Math.min(4, Math.max(1, Math.round(targetHeight / source.height)));
          const canvas = document.createElement('canvas');
          canvas.width = source.width * zoom;
          canvas.height = source.height * zoom;
          const context = canvas.getContext('2d');
          if (!context) return { error: 'no 2d canvas' };
          // a transparent background would reach the model as black
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(source.picture, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let blank = true;
          for (let i = 4; i < pixels.length && blank; i += 4) {
            blank = pixels[i] === pixels[0] && pixels[i + 1] === pixels[1] && pixels[i + 2] === pixels[2];
          }
          return { png: canvas.toDataURL('image/png').split(',')[1], blank, size: `${canvas.width}x${canvas.height}` };
        } catch (error) {
          // a picture from another site taints the canvas
          return { error: String(error) };
        }
      }, CAPTCHA_TARGET_HEIGHT)
      .catch(error => ({ error: String(error) }));
    if ('png' in copied && copied.png && !copied.blank) {
      logger.info(`[captcha] picture copied from the page, ${copied.size}`);
      return { image: copied.png, textAround: described?.textAround ?? '' };
    }
    const notCopied = 'png' in copied ? 'the copied picture is one colour' : copied.error;
    logger.warning(`[captcha] picture not copied (${notCopied}), taking it from the screen`);

    const screenshot = (await this._puppeteerPage.screenshot({
      encoding: 'base64',
      type: 'png',
      clip: { x: box.x + pageLeft, y: box.y + pageTop, width: box.width, height: box.height, scale },
    })) as string;
    if (await isBlankPng(screenshot)) {
      throw new Error(
        `the captcha came out blank (one colour) on screen, so there is nothing to read: the tab may be hidden behind another window or not painted (${notCopied})`,
      );
    }
    return { image: screenshot, textAround: described?.textAround ?? '' };
  }

  /** Scroll an element into view, put the cursor in it and outline it for a moment: what the user is asked to fill */
  async revealElement(elementNode: DOMElementNode): Promise<void> {
    const element = await this.locateElement(elementNode);
    if (!element) return;
    await element.evaluate(el => {
      const html = el as HTMLElement;
      html.scrollIntoView({ block: 'center', inline: 'nearest' });
      html.focus?.({ preventScroll: true });
      const { outline, outlineOffset } = html.style;
      html.style.outline = '2px solid #e8a33d';
      html.style.outlineOffset = '2px';
      setTimeout(() => {
        html.style.outline = outline;
        html.style.outlineOffset = outlineOffset;
      }, 2500);
    });
  }

  /** @returns what the field contains after typing, or null when it is gone from the page */
  async inputTextElementNode(useVision: boolean, elementNode: DOMElementNode, text: string): Promise<string | null> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Highlight before typing
      // if (elementNode.highlightIndex != null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const located = await this.locateElement(elementNode);
      if (!located) {
        throw new ElementNotFoundError(`Element: ${elementNode} not found`);
      }
      await this.assertSameElement(located, elementNode);
      const element = await this.textFieldOf(located);

      // Ensure element is ready for input
      try {
        // First wait for element stability
        await this._waitForElementStability(element, 1500);

        // Then check visibility and scroll into view if needed
        const isHidden = await element.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(element, 1500);
        }
      } catch (e) {
        // Continue even if these operations fail
        logger.debug(`Non-critical error preparing element: ${e}`);
      }
      await this.markAgentTarget(element, 'type', elementNode);

      // Get element properties to determine input method
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      const isContentEditable = await element.evaluate(el => {
        if (el instanceof HTMLElement) {
          return el.isContentEditable;
        }
        return false;
      });
      const isReadOnly = await element.evaluate(el => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return el.readOnly;
        }
        return false;
      });
      const isDisabled = await element.evaluate(el => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return el.disabled;
        }
        return false;
      });

      // Choose appropriate input method based on element properties
      if ((isContentEditable || tagName === 'input' || tagName === 'textarea') && !isReadOnly && !isDisabled) {
        // Empty the field the way a user does: select what it contains and delete it. A page that keeps the
        // text in its own state puts it back after a value set from script, and the new text lands behind it.
        await element.focus();
        const hasContent = await element.evaluate(el => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.select();
            return el.value !== '';
          }
          el.ownerDocument.getSelection()?.selectAllChildren(el);
          return (el.textContent ?? '') !== '';
        });
        if (hasContent) {
          await this._puppeteerPage.keyboard.press('Backspace');
        }
        // What the keys did not remove is cleared directly
        await element.evaluate(el => {
          const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
          const value = isField ? el.value : (el.textContent ?? '');
          if (value === '') return;
          if (isField) {
            el.value = '';
          } else {
            el.textContent = '';
          }
          // Dispatch events
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        if (tagName === 'textarea') {
          // A textarea takes long, multi-line text: each line is inserted as the keyboard would deliver it, so
          // a page that keeps the text itself takes it over (a value set from script is dropped when the page
          // renders again). Lines are joined with Shift+Enter, as a bare Enter sends the message in a chat box.
          const keyboard = this._puppeteerPage.keyboard;
          for (const [i, line] of text.split(/\r?\n/).entries()) {
            if (i > 0) {
              await keyboard.down('Shift');
              await keyboard.press('Enter');
              await keyboard.up('Shift');
            }
            if (line) await keyboard.sendCharacter(line);
          }
        } else {
          // Type the text with a small delay between keypresses
          await element.type(text, { delay: 50 });
        }
      } else {
        // Use direct value setting for other types of elements
        await element.evaluate((el, value) => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.value = value;
          } else if (el instanceof HTMLElement && el.isContentEditable) {
            el.textContent = value;
          }
          // Dispatch events
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, text);
      }

      // Wait for page stability after input
      await this.waitForPageAndFramesLoad();

      // Success is what the field holds afterwards, not that the keys were sent
      const content = await element
        .evaluate(el =>
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? ''),
        )
        // the field is gone: typing moved the page on
        .catch(() => null);
      if (content !== null && text.trim() !== '' && content.trim() === '') {
        throw new Error('the field is still empty after typing, so it did not take the text');
      }
      return content;
    } catch (error) {
      const errorMsg = `Failed to input text into element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMsg);
      // a re-rendered field can be found again by the caller
      if (error instanceof ElementNotFoundError) throw new ElementNotFoundError(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Where text for an element goes: the element itself if it is a field, else the field inside it or the one
   * a click on it focuses (a search bar with filter chips, a styled wrapper). Setting a value on anything
   * else changes nothing on the page while the action reports success.
   */
  private async textFieldOf(element: ElementHandle): Promise<ElementHandle> {
    const find = async (focused: boolean) => {
      const handle = await element.evaluateHandle((el, focused) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
        if (el instanceof HTMLElement && el.isContentEditable) return el;
        const fields =
          'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]), textarea, [contenteditable]:not([contenteditable="false"])';
        const inside = Array.from(el.querySelectorAll(fields)).find(field => field.getClientRects().length > 0);
        if (inside) return inside;
        const active = el.ownerDocument.activeElement;
        return focused && active?.matches(fields) ? active : null;
      }, focused);
      return handle.asElement() as ElementHandle | null;
    };

    let field = await find(false);
    if (!field) {
      await element.click();
      field = await find(true);
    }
    if (!field) {
      throw new Error('it is not a text field and there is none inside it');
    }
    return field;
  }

  /**
   * Wait for an element to become stable (no position/size changes)
   * Similar to Playwright's wait_for_element_state('stable')
   */
  private async _waitForElementStability(element: ElementHandle, timeout = 1000): Promise<void> {
    const startTime = Date.now();
    let lastRect = await element.boundingBox();

    while (Date.now() - startTime < timeout) {
      // Wait a short time
      await new Promise(resolve => setTimeout(resolve, 50));

      // Get current position and size
      const currentRect = await element.boundingBox();

      // If element is no longer in DOM or not visible
      if (!currentRect) {
        break;
      }

      // Compare with previous position/size
      if (
        lastRect &&
        Math.abs(lastRect.x - currentRect.x) < 2 &&
        Math.abs(lastRect.y - currentRect.y) < 2 &&
        Math.abs(lastRect.width - currentRect.width) < 2 &&
        Math.abs(lastRect.height - currentRect.height) < 2
      ) {
        // Position is stable - wait a bit more to be sure and then return
        await new Promise(resolve => setTimeout(resolve, 50));
        return;
      }

      // Update last position
      lastRect = currentRect;
    }

    // If we got here, either the element stabilized or we timed out
    logger.debug('Element stability check completed (timeout or stable)');
  }

  private async _scrollIntoViewIfNeeded(element: ElementHandle, timeout = 1000): Promise<void> {
    const startTime = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check if element is in viewport
      const where = await element.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        // No scrolling shows an element without size or one hidden by its style, like the real checkbox under a
        // styled one: waiting for it would only delay the click
        if (
          rect.width === 0 ||
          rect.height === 0 ||
          style.visibility === 'hidden' ||
          style.display === 'none' ||
          style.opacity === '0'
        ) {
          return 'hidden';
        }

        // Check if element is in viewport
        const isInViewport =
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth);

        if (!isInViewport) {
          // Scroll into view if not visible
          el.scrollIntoView({
            behavior: 'auto',
            block: 'center',
            inline: 'center',
          });
          return 'scrolled';
        }

        return 'visible';
      });

      if (where === 'visible') break;
      if (where === 'hidden') {
        logger.info('Element is hidden or has no size, not waiting for it to scroll into view');
        break;
      }

      // Check timeout - log warning and return instead of throwing
      if (Date.now() - startTime > timeout) {
        logger.warning('Timed out while trying to scroll element into view, continuing anyway');
        break;
      }

      // Small delay before next check
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Click an element. For a checkbox or radio button, resolves to whether it is checked afterwards.
   */
  async clickElementNode(useVision: boolean, elementNode: DOMElementNode): Promise<boolean | undefined> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Highlight before clicking
      // if (elementNode.highlightIndex !== null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new ElementNotFoundError(`Element: ${elementNode} not found`);
      }
      await this.assertSameElement(element, elementNode);

      // Scroll element into view if needed
      await this._scrollIntoViewIfNeeded(element);
      await this.markAgentTarget(element, 'click', elementNode);

      // A real checkbox hidden under a styled one: a click on the input itself can tick it while the page
      // still reads the styled box (and refuses to submit), so click what a person would click
      const ticked = await this.clickStyledCheckbox(element);
      if (ticked !== null) {
        await this._checkAndHandleNavigation();
        return ticked;
      }

      try {
        // A mouse click lands on whatever is on top at the element's center (a toast, a hover card, a
        // neighbouring button); dispatch the click on the element itself when something else is there.
        if (await this.isCoveredAtCenter(element)) {
          logger.info('Element is covered at its center, clicking it directly');
          // a mouse click also puts the focus there: keys sent next must reach a field clicked this way
          await element.evaluate(el => {
            (el as HTMLElement).focus();
            (el as HTMLElement).click();
          });
          await this._checkAndHandleNavigation();
          return undefined;
        }
        // First attempt: a mouse click at the element's center. Not element.click(): it first waits on an
        // IntersectionObserver, which stalls for seconds whenever the tab is not being rendered (e.g. covered
        // by the devtools window); the element was already scrolled into view above.
        const box = await element.boundingBox();
        if (!box) throw new Error('Element has no layout box');
        await element.evaluate((el, flag) => {
          const w = window as unknown as Record<string, boolean>;
          w[flag] = false;
          const onPress = (e: Event) => {
            if (e.composedPath().includes(el)) w[flag] = true;
          };
          document.addEventListener('pointerdown', onPress, { capture: true, once: true });
        }, PRESSED_FLAG);
        await Promise.race([
          this._puppeteerPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2),
          new Promise((_, reject) => setTimeout(() => reject(new Error(CLICK_TIMEOUT)), 2000)),
        ]);
        await this._checkAndHandleNavigation();
      } catch (error) {
        // if URLNotAllowedError, throw it
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
        // If the press already reached the element, clicking again would close the menu the first click
        // opened, or confirm a dialog twice
        if (error instanceof Error && error.message === CLICK_TIMEOUT && (await this.wasPressed(element))) {
          logger.info('Click reached the element but was acknowledged late, not clicking again');
          return undefined;
        }
        // Second attempt: Use evaluate to perform a direct click
        logger.info('Failed to click element, trying again', error);
        try {
          await element.evaluate(el => (el as HTMLElement).click());
        } catch (secondError) {
          // if URLNotAllowedError, throw it
          if (secondError instanceof URLNotAllowedError) {
            throw secondError;
          }
          throw new Error(
            `Failed to click element: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof ElementChangedError || error instanceof ElementNotFoundError) throw error;
      throw new Error(
        `Failed to click element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }

  /**
   * Throw if the live element no longer matches the one the model chose (the page re-rendered and the
   * locator now resolves to a different element), so we never act on something the model did not see.
   */
  private async assertSameElement(handle: ElementHandle, node: DOMElementNode): Promise<void> {
    const expected = {
      tag: (node.tagName ?? '').toLowerCase(),
      attributes: Object.fromEntries(IDENTITY_ATTRIBUTES.map(name => [name, node.attributes[name] ?? null])),
    };
    const mismatch = await handle.evaluate((el, exp) => {
      if (exp.tag && el.tagName.toLowerCase() !== exp.tag) return `<${el.tagName.toLowerCase()}>`;
      for (const [name, value] of Object.entries(exp.attributes)) {
        const live = el.getAttribute(name);
        if (live !== value) return `${name}=${JSON.stringify(live)}`;
      }
      return null;
    }, expected);
    if (mismatch) {
      const label = node.attributes['aria-label'] ?? node.getAllTextTillNextClickableElement(2);
      throw new ElementChangedError(
        `Element [${node.highlightIndex}] "${collapseLabel(label)}" changed since the page was read (now ${mismatch}); nothing was done. Look at the page again before acting.`,
      );
    }
  }

  /**
   * Find an element again in a fresh DOM read, after the page re-rendered it (its path changed).
   * Only a single element with the same tag, identity attributes and text counts; otherwise null.
   */
  async relocateElement(node: DOMElementNode): Promise<DOMElementNode | null> {
    const identity = (n: DOMElementNode) =>
      JSON.stringify([
        n.tagName?.toLowerCase(),
        IDENTITY_ATTRIBUTES.map(name => n.attributes[name] ?? null),
        n.getAllTextTillNextClickableElement(2),
      ]);
    const wanted = identity(node);
    const state = await this.getState();
    const matches = [...state.selectorMap.values()].filter(n => identity(n) === wanted);
    return matches.length === 1 ? matches[0] : null;
  }

  /** Whether the pointerdown armed before a click reached the element; assume it did if the page went away */
  private async wasPressed(handle: ElementHandle): Promise<boolean> {
    try {
      return await handle.evaluate(
        (_, flag) => (window as unknown as Record<string, boolean>)[flag] === true,
        PRESSED_FLAG,
      );
    } catch {
      return true;
    }
  }

  /**
   * Click a checkbox or radio button that is hidden or covered (by its styled stand-in) the way a person
   * would: on the stand-in at its center, else its label, else a sized sibling. Falls back to the input
   * itself when that changed nothing. Null when the element is no such box, or is plainly clickable.
   */
  private async clickStyledCheckbox(handle: ElementHandle): Promise<boolean | null> {
    return handle.evaluate(el => {
      const input = el as HTMLInputElement;
      if (input.tagName !== 'INPUT' || (input.type !== 'checkbox' && input.type !== 'radio')) return null;
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      const hidden =
        rect.width === 0 ||
        rect.height === 0 ||
        style.visibility === 'hidden' ||
        style.display === 'none' ||
        style.opacity === '0';
      const root = input.getRootNode() as Document | ShadowRoot;
      const hit = hidden ? null : root.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hidden && (!hit || hit === input)) return null;

      const sized = (n: Element | null): n is HTMLElement => {
        if (!(n instanceof HTMLElement)) return false;
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // never a link: the label of an agreement box usually holds one, and following it leaves the page
      const notLink = (n: Element | null) => !!n && !n.closest('a');
      const container = input.closest('label') ?? input.parentElement;
      const candidates: (Element | null)[] = [
        hit && container?.contains(hit) ? hit : null,
        ...Array.from(input.labels ?? []),
        input.nextElementSibling,
        input.previousElementSibling,
      ];
      const standIn = candidates.find(n => n !== input && sized(n) && notLink(n)) as HTMLElement | undefined;

      const before = input.checked;
      const classBefore = standIn?.className;
      standIn?.click();
      if (!standIn || (input.checked === before && standIn.className === classBefore)) {
        input.focus();
        input.click();
      }
      return input.checked;
    });
  }

  private async isCoveredAtCenter(handle: ElementHandle): Promise<boolean> {
    try {
      return await handle.evaluate(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const root = el.getRootNode() as Document | ShadowRoot;
        const hit = root.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !!hit && hit !== el && !el.contains(hit);
      });
    } catch {
      return false;
    }
  }

  getSelectorMap(): Map<number, DOMElementNode> {
    // If there is no cached state, return an empty map
    if (this._cachedState === null) {
      return new Map();
    }
    // Otherwise return the cached state's selector map
    return this._cachedState.selectorMap;
  }

  async getElementByIndex(index: number): Promise<ElementHandle | null> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap.get(index);
    if (!element) return null;
    return await this.locateElement(element);
  }

  getDomElementByIndex(index: number): DOMElementNode | null {
    const selectorMap = this.getSelectorMap();
    return selectorMap.get(index) || null;
  }

  isFileUploader(elementNode: DOMElementNode, maxDepth = 3, currentDepth = 0): boolean {
    if (currentDepth > maxDepth) {
      return false;
    }

    // Check current element
    if (elementNode.tagName === 'input') {
      // Check for file input attributes
      const attributes = elementNode.attributes;
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      if (attributes['type']?.toLowerCase() === 'file' || !!attributes['accept']) {
        return true;
      }
    }

    // Recursively check children
    if (elementNode.children && currentDepth < maxDepth) {
      for (const child of elementNode.children) {
        if ('tagName' in child) {
          // DOMElementNode type guard
          if (this.isFileUploader(child as DOMElementNode, maxDepth, currentDepth + 1)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  async waitForPageLoadState(timeout?: number) {
    const timeoutValue = timeout || 8000;
    await this._puppeteerPage?.waitForNavigation({ timeout: timeoutValue });
  }

  private async _waitForStableNetwork() {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    const RELEVANT_RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'font', 'script', 'iframe']);

    const RELEVANT_CONTENT_TYPES = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'image/',
      'font/',
      'application/json',
    ]);

    const IGNORED_URL_PATTERNS = new Set([
      // Analytics and tracking
      'analytics',
      'tracking',
      'telemetry',
      'beacon',
      'metrics',
      // Ad-related
      'doubleclick',
      'adsystem',
      'adserver',
      'advertising',
      // Social media widgets
      'facebook.com/plugins',
      'platform.twitter',
      'linkedin.com/embed',
      // Live chat and support
      'livechat',
      'zendesk',
      'intercom',
      'crisp.chat',
      'hotjar',
      // Push notifications
      'push-notifications',
      'onesignal',
      'pushwoosh',
      // Background sync/heartbeat
      'heartbeat',
      'ping',
      'alive',
      // WebRTC and streaming
      'webrtc',
      'rtmp://',
      'wss://',
      // Common CDNs
      'cloudfront.net',
      'fastly.net',
    ]);

    const pendingRequests = new Set();
    let lastActivity = Date.now();

    const onRequest = (request: HTTPRequest) => {
      // Filter by resource type
      const resourceType = request.resourceType();
      if (!RELEVANT_RESOURCE_TYPES.has(resourceType)) {
        return;
      }

      // Filter out streaming, websocket, and other real-time requests
      if (['websocket', 'media', 'eventsource', 'manifest', 'other'].includes(resourceType)) {
        return;
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase();
      if (Array.from(IGNORED_URL_PATTERNS).some(pattern => url.includes(pattern))) {
        return;
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter out requests with certain headers
      const headers = request.headers();
      if (
        // biome-ignore lint/complexity/useLiteralKeys: <explanation>
        headers['purpose'] === 'prefetch' ||
        headers['sec-fetch-dest'] === 'video' ||
        headers['sec-fetch-dest'] === 'audio'
      ) {
        return;
      }

      pendingRequests.add(request);
      lastActivity = Date.now();
    };

    const onResponse = (response: HTTPResponse) => {
      const request = response.request();
      if (!pendingRequests.has(request)) {
        return;
      }

      // Filter by content type
      const contentType = response.headers()['content-type']?.toLowerCase() || '';

      // Skip streaming content
      if (
        ['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf'].some(t =>
          contentType.includes(t),
        )
      ) {
        pendingRequests.delete(request);
        return;
      }

      // Only process relevant content types
      if (!Array.from(RELEVANT_CONTENT_TYPES).some(ct => contentType.includes(ct))) {
        pendingRequests.delete(request);
        return;
      }

      // Skip large responses
      const contentLength = response.headers()['content-length'];
      if (contentLength && Number.parseInt(contentLength) > 5 * 1024 * 1024) {
        // 5MB
        pendingRequests.delete(request);
        return;
      }

      pendingRequests.delete(request);
      lastActivity = Date.now();
    };

    // Add event listeners
    this._puppeteerPage.on('request', onRequest);
    this._puppeteerPage.on('response', onResponse);

    try {
      const startTime = Date.now();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const now = Date.now();
        const timeSinceLastActivity = (now - lastActivity) / 1000; // Convert to seconds

        if (pendingRequests.size === 0 && timeSinceLastActivity >= this._config.waitForNetworkIdlePageLoadTime) {
          break;
        }

        const elapsedTime = (now - startTime) / 1000; // Convert to seconds
        if (elapsedTime > this._config.maximumWaitPageLoadTime) {
          console.debug(
            `Network timeout after ${this._config.maximumWaitPageLoadTime}s with ${pendingRequests.size} pending requests:`,
            Array.from(pendingRequests).map(r => (r as HTTPRequest).url()),
          );
          break;
        }
      }
    } finally {
      // Clean up event listeners
      this._puppeteerPage.off('request', onRequest);
      this._puppeteerPage.off('response', onResponse);
    }
    console.debug(`Network stabilized for ${this._config.waitForNetworkIdlePageLoadTime} seconds`);
  }

  async waitForPageAndFramesLoad(timeoutOverwrite?: number): Promise<void> {
    // Start timing
    const startTime = Date.now();

    // Wait for page load
    try {
      await this._waitForStableNetwork();

      // Check if the loaded URL is allowed
      if (this._puppeteerPage) {
        await this._checkAndHandleNavigation();
      }
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }
      console.warn('Page load failed, continuing...', error);
    }

    // Calculate remaining time to meet minimum wait time
    const elapsed = (Date.now() - startTime) / 1000; // Convert to seconds
    const minWaitTime = timeoutOverwrite || this._config.minimumWaitPageLoadTime;
    const remaining = Math.max(minWaitTime - elapsed, 0);

    console.debug(
      `--Page loaded in ${elapsed.toFixed(2)} seconds, waiting for additional ${remaining.toFixed(2)} seconds`,
    );

    // Sleep remaining time if needed
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining * 1000)); // Convert seconds to milliseconds
    }
  }

  /**
   * Check the current page URL and handle if it's not allowed
   * @throws URLNotAllowedError if the current URL is not allowed
   */
  private async _checkAndHandleNavigation(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    const currentUrl = this._puppeteerPage.url();
    if (!isUrlAllowed(currentUrl, this._config.allowedUrls, this._config.deniedUrls)) {
      const errorMessage = `URL: ${currentUrl} is not allowed`;
      logger.error(errorMessage);

      // Navigate to home page or about:blank
      const safeUrl = this._config.homePageUrl || 'about:blank';
      logger.info(`Redirecting to safe URL: ${safeUrl}`);

      try {
        await this._puppeteerPage.goto(safeUrl);
      } catch (error) {
        logger.error(`Failed to redirect to safe URL: ${error instanceof Error ? error.message : String(error)}`);
      }

      throw new URLNotAllowedError(errorMessage);
    }
  }
}
