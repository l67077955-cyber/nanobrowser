import { useState, useEffect, useCallback } from 'react';
import { remoteControlStore, DEFAULT_REMOTE_CONTROL } from '@extension/storage';
import { Button } from '@extension/ui';
import { t } from '@extension/i18n';

const TOGGLE_LABEL = `peer h-6 w-11 rounded-full bg-nb-track after:absolute after:left-[2px] after:top-[2px] after:size-5 after:rounded-full after:border after:border-nb-line after:bg-nb-tile after:transition-all after:content-[''] peer-checked:bg-nb-llm peer-checked:after:translate-x-full peer-checked:after:border-nb-llm peer-focus:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-nb-llm`;
const INPUT = `flex-1 rounded-md border border-nb-line bg-nb-tile-2 px-3 py-2 text-sm text-nb-ink focus:border-nb-llm focus:outline-none`;
const QUIET_BUTTON = `border border-nb-line bg-nb-tile-2 px-3 py-2 text-sm text-nb-ink-2 shadow-none hover:bg-nb-tile hover:text-nb-ink`;

type Status = 'off' | 'connecting' | 'connected' | 'rejected' | 'unreachable';

const STATUS_TEXT = {
  off: 'options_remote_status_off',
  connecting: 'options_remote_status_connecting',
  connected: 'options_remote_status_connected',
  rejected: 'options_remote_status_rejected',
  unreachable: 'options_remote_status_unreachable',
} as const;

/** An address that leaves this computer without encryption */
function isInsecure(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

export const RemoteSettings = () => {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState(DEFAULT_REMOTE_CONTROL.url);
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState({ url: DEFAULT_REMOTE_CONTROL.url, token: '' });
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<Status>('off');

  const load = useCallback(async () => {
    const config = await remoteControlStore.getConfig();
    setEnabled(config.enabled);
    setUrl(config.url);
    setToken(config.token);
    setSaved({ url: config.url, token: config.token });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // the connection is the background's; ask it how it is doing while this tab is open
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const reply = (await chrome.runtime.sendMessage({ type: 'remote_status' })) as { status?: Status } | undefined;
        if (active && reply?.status) setStatus(reply.status);
      } catch {
        // the background is restarting
      }
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const handleToggle = async (value: boolean) => {
    await remoteControlStore.updateConfig({ enabled: value });
    setEnabled(value);
  };

  const handleSave = async () => {
    const next = { url: url.trim(), token: token.trim() };
    await remoteControlStore.updateConfig(next);
    setUrl(next.url);
    setToken(next.token);
    setSaved(next);
  };

  const dirty = url.trim() !== saved.url || token.trim() !== saved.token;
  const statusTone =
    status === 'connected'
      ? 'bg-nb-good'
      : status === 'off' || status === 'connecting'
        ? 'bg-nb-track'
        : 'bg-nb-critical';

  return (
    <section className="space-y-6">
      <div className={`rounded-xl border border-nb-line bg-nb-tile p-6 text-left shadow-nb`}>
        <h2 className={`mb-2 text-base font-semibold tracking-tight text-nb-ink`}>{t('options_remote_header')}</h2>
        <p className={`mb-6 text-sm text-nb-muted`}>{t('options_remote_intro')}</p>

        <div className="space-y-6">
          <div className="flex items-center justify-between gap-6">
            <div>
              <h3 className={`text-base font-medium text-nb-ink-2`}>{t('options_remote_enable')}</h3>
              <p className={`text-sm font-normal text-nb-muted`}>{t('options_remote_enable_desc')}</p>
            </div>
            <div className="relative inline-flex cursor-pointer items-center">
              <input
                id="remote-enabled"
                type="checkbox"
                checked={enabled}
                onChange={e => handleToggle(e.target.checked)}
                className="peer sr-only"
              />
              <label htmlFor="remote-enabled" className={TOGGLE_LABEL}>
                <span className="sr-only">{t('options_remote_enable')}</span>
              </label>
            </div>
          </div>

          <div>
            <label htmlFor="remote-url" className={`text-base font-medium text-nb-ink-2`}>
              {t('options_remote_url')}
            </label>
            <p className={`mb-2 text-sm font-normal text-nb-muted`}>{t('options_remote_url_desc')}</p>
            <div className="flex">
              <input
                id="remote-url"
                type="text"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder={DEFAULT_REMOTE_CONTROL.url}
                spellCheck={false}
                className={INPUT}
              />
            </div>
            {isInsecure(url) && (
              <p role="alert" className="mt-2 text-sm text-nb-critical">
                {t('options_remote_insecure')}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="remote-token" className={`text-base font-medium text-nb-ink-2`}>
              {t('options_remote_token')}
            </label>
            <p className={`mb-2 text-sm font-normal text-nb-muted`}>{t('options_remote_token_desc')}</p>
            <div className="flex space-x-2">
              <input
                id="remote-token"
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={e => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className={INPUT}
              />
              <Button onClick={() => setShowToken(!showToken)} className={QUIET_BUTTON}>
                {showToken ? t('options_remote_btnHide') : t('options_remote_btnShow')}
              </Button>
              <Button onClick={handleSave} disabled={!dirty} className="px-4 py-2 text-sm">
                {t('options_remote_btnSave')}
              </Button>
            </div>
          </div>

          <div className={`rounded-lg border border-nb-hair bg-nb-tile-2 p-4`}>
            <div className="flex items-center justify-between">
              <span className={`text-sm font-medium text-nb-ink-2`}>{t('options_remote_status')}</span>
              <span role="status" className="flex items-center gap-2 text-sm text-nb-ink">
                <span className={`inline-block size-2 rounded-full ${statusTone}`} />
                {t(STATUS_TEXT[status])}
              </span>
            </div>
            <p className={`mt-2 text-sm text-nb-muted`}>{t('options_remote_confirm_note')}</p>
          </div>
        </div>
      </div>
    </section>
  );
};
