import { t } from '@extension/i18n';
import { type ReactNode, useEffect, useState } from 'react';
import { FiGlobe } from 'react-icons/fi';
import { getTargetTab } from '../utils';
import { hostOf } from './steps';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return t('welcome_greeting_morning');
  if (hour >= 12 && hour < 18) return t('welcome_greeting_afternoon');
  return t('welcome_greeting_evening');
}

/** The tab a task would start on, kept up to date as the user moves between tabs */
function useTargetTab(): chrome.tabs.Tab | undefined {
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  useEffect(() => {
    let current = true;
    const load = () => {
      getTargetTab()
        .then(target => current && setTab(target))
        .catch(error => console.error('Failed to find the tab in front:', error));
    };
    load();
    chrome.tabs.onActivated.addListener(load);
    chrome.tabs.onUpdated.addListener(load);
    chrome.windows.onFocusChanged.addListener(load);
    return () => {
      current = false;
      chrome.tabs.onActivated.removeListener(load);
      chrome.tabs.onUpdated.removeListener(load);
      chrome.windows.onFocusChanged.removeListener(load);
    };
  }, []);
  return tab;
}

/** What a new chat opens to: a greeting, the page a task would start on, and the saved tasks */
export default function Welcome({ children }: { children?: ReactNode }) {
  const tab = useTargetTab();
  const [iconFailed, setIconFailed] = useState(false);
  const isWebPage = tab?.url ? /^https?:/.test(tab.url) : false;

  useEffect(() => setIconFailed(false), [tab?.favIconUrl]);

  return (
    <div className="nb-welcome">
      <div className="nb-welcome-hero">
        <img src="/icon-128.png" alt="" className="nb-welcome-logo" />
        <h1>{greeting()}</h1>
        <p>{t('welcome_prompt')}</p>
        {tab && isWebPage && (
          <div className="nb-welcome-tab" title={tab.url}>
            <span>{t('welcome_startsOn')}</span>
            {tab.favIconUrl && !iconFailed ? (
              <img src={tab.favIconUrl} alt="" onError={() => setIconFailed(true)} />
            ) : (
              <FiGlobe aria-hidden />
            )}
            <b>{tab.title || hostOf(tab.url ?? '')}</b>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
