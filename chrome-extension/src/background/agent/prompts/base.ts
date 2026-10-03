import { HumanMessage, type SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { wrapUntrustedContent } from '../messages/utils';
import { createLogger } from '@src/background/log';

/** A page no taller than the viewport cannot scroll; dividing by that ~0 distance gave 631884% and -157588% */
/**
 * Where the visible part of the page is, as progress. The share of the page the viewport covers was given
 * as a percentage before, and models read it as how far down they were.
 */
export function scrollPosition(scrollY: number, viewportHeight: number, scrollHeight: number): string {
  const scrollable = scrollHeight - viewportHeight;
  if (scrollable < 1) return 'the whole page fits on screen, there is nothing to scroll';
  const above = Math.max(0, Math.round(scrollY));
  const below = Math.max(0, Math.round(scrollHeight - viewportHeight - scrollY));
  const progress = Math.min(100, Math.round((above / scrollable) * 100));
  const where = below === 0 ? 'at the bottom' : above === 0 ? 'at the top' : `${progress}% of the way down`;
  return `${where}: ${above}px above and ${below}px below the visible part (screen height ${Math.round(viewportHeight)}px, page height ${Math.round(scrollHeight)}px)`;
}

/** YYYY-MM-DD HH:mm (Weekday) in the browser's time zone: "at 9" from the user means their 9 */
export function localDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = date.toLocaleDateString('en-US', { weekday: 'long' });
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} (${day})`;
}

const logger = createLogger('BasePrompt');
/**
 * Abstract base class for all prompt types
 */
abstract class BasePrompt {
  /**
   * Returns the system message that defines the AI's role and behavior
   * @returns SystemMessage from LangChain
   */
  abstract getSystemMessage(): SystemMessage;

  /**
   * Returns the user message for the specific prompt type
   * @param context - Optional context data needed for generating the user message
   * @returns HumanMessage from LangChain
   */
  abstract getUserMessage(context: AgentContext): Promise<HumanMessage>;

  /**
   * Builds the user message containing the browser state
   * @param context - The agent context
   * @returns HumanMessage from LangChain
   */
  async buildBrowserStateUserMessage(context: AgentContext): Promise<HumanMessage> {
    const browserState = await context.browserContext.getState(context.options.useVision);
    const rawElementsText = browserState.elementTree.clickableElementsToString(context.options.includeAttributes);

    let formattedElementsText = '';
    if (rawElementsText !== '') {
      const scrollInfo = `[Scroll info of current page] ${scrollPosition(browserState.scrollY, browserState.visualViewportHeight, browserState.scrollHeight)}\n`;
      logger.info(scrollInfo);
      const elementsText = wrapUntrustedContent(rawElementsText);
      formattedElementsText = `${scrollInfo}[Start of page]\n${elementsText}\n[End of page]\n`;
    } else if (browserState.unreadable) {
      formattedElementsText =
        'The page in this tab could not be read: it failed to load (the browser shows its own error page), is still loading, or cannot be accessed. There is nothing to click here. Wait and look again if it may still be loading; otherwise go to another URL or go back, and do not keep retrying an address that fails to load.';
    } else {
      formattedElementsText = 'empty page';
    }

    let stepInfoDescription = '';
    if (context.stepInfo) {
      stepInfoDescription = `Current step: ${context.stepInfo.stepNumber + 1}/${context.stepInfo.maxSteps}`;
    }

    stepInfoDescription += `\nCurrent date and time: ${localDateTime(new Date())}`;

    let actionResultsDescription = '';
    if (context.actionResults.length > 0) {
      for (let i = 0; i < context.actionResults.length; i++) {
        const result = context.actionResults[i];
        if (result.extractedContent) {
          actionResultsDescription += `\nAction result ${i + 1}/${context.actionResults.length}: ${result.extractedContent}`;
        }
        if (result.error) {
          // only use last line of error
          const error = result.error.split('\n').pop();
          actionResultsDescription += `\nAction error ${i + 1}/${context.actionResults.length}: ...${error}`;
        }
      }
    }

    const currentTab = `{id: ${browserState.tabId}, url: ${browserState.url}, title: ${browserState.title}}`;
    const otherTabs = browserState.tabs
      .filter(tab => tab.id !== browserState.tabId)
      .map(tab => `- {id: ${tab.id}, url: ${tab.url}, title: ${tab.title}}`);
    const stateDescription = `
[Task history memory ends]
[Current state starts here]
The following is one-time information - if you need to remember it write it to memory:
Current tab: ${currentTab}
Other available tabs:
  ${otherTabs.join('\n')}
Interactive elements from top layer of the current page inside the viewport:
${formattedElementsText}
${stepInfoDescription}
${actionResultsDescription}
`;

    if (browserState.screenshot && context.options.useVision) {
      return new HumanMessage({
        content: [
          { type: 'text', text: stateDescription },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${browserState.screenshot}` },
          },
        ],
      });
    }

    return new HumanMessage(stateDescription);
  }
}

export { BasePrompt };
