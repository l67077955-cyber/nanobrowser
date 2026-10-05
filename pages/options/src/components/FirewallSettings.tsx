import { useState, useEffect, useCallback } from 'react';
import { firewallStore, normalizeSiteEntry } from '@extension/storage';
import { Button } from '@extension/ui';
import { t } from '@extension/i18n';

export const FirewallSettings = () => {
  const [isEnabled, setIsEnabled] = useState(true);
  const [allowList, setAllowList] = useState<string[]>([]);
  const [denyList, setDenyList] = useState<string[]>([]);
  const [newUrl, setNewUrl] = useState('');
  const [activeList, setActiveList] = useState<'allow' | 'deny'>('allow');
  const [notice, setNotice] = useState('');

  const loadFirewallSettings = useCallback(async () => {
    const settings = await firewallStore.getFirewall();
    setIsEnabled(settings.enabled);
    setAllowList(settings.allowList);
    setDenyList(settings.denyList);
  }, []);

  useEffect(() => {
    loadFirewallSettings();
    // rules saved in another settings tab show up here
    return firewallStore.subscribe(loadFirewallSettings);
  }, [loadFirewallSettings]);

  const handleToggleFirewall = async () => {
    await firewallStore.updateFirewall({ enabled: !isEnabled });
    await loadFirewallSettings();
  };

  const handleAddUrl = async () => {
    const entry = normalizeSiteEntry(newUrl);
    if (!entry) return;

    const moved =
      activeList === 'allow' ? await firewallStore.addToAllowList(entry) : await firewallStore.addToDenyList(entry);
    setNotice(
      moved ? t(activeList === 'allow' ? 'options_firewall_movedToAllow' : 'options_firewall_movedToDeny', entry) : '',
    );
    await loadFirewallSettings();
    setNewUrl('');
  };

  const handleRemoveUrl = async (url: string, listType: 'allow' | 'deny') => {
    if (listType === 'allow') {
      await firewallStore.removeFromAllowList(url);
    } else {
      await firewallStore.removeFromDenyList(url);
    }
    await loadFirewallSettings();
  };

  return (
    <section className="space-y-6">
      <div className={`rounded-xl border border-nb-line bg-nb-tile p-6 text-left shadow-nb`}>
        <h2 className={`mb-4 text-base font-semibold tracking-tight text-nb-ink`}>{t('options_firewall_header')}</h2>

        <div className="space-y-6">
          <div className={`my-6 rounded-lg border border-nb-hair bg-nb-tile-2 p-4`}>
            <div className="flex items-center justify-between">
              <label htmlFor="toggle-firewall" className={`text-base font-medium text-nb-ink`}>
                {t('options_firewall_enableToggle')}
              </label>
              <div className="relative inline-block w-[38px] select-none">
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={handleToggleFirewall}
                  className="sr-only"
                  id="toggle-firewall"
                />
                <label
                  htmlFor="toggle-firewall"
                  className={`block h-[22px] cursor-pointer overflow-hidden rounded-full p-[2px] ${
                    isEnabled ? 'bg-nb-llm' : 'bg-nb-track'
                  }`}>
                  <span className="sr-only">{t('options_firewall_toggleFirewall_a11y')}</span>
                  <span
                    className={`block size-[18px] rounded-full bg-nb-tile shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform ${
                      isEnabled ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="mb-6 mt-10 flex items-center justify-between">
            <div className="flex space-x-2">
              <Button
                onClick={() => setActiveList('allow')}
                className={`px-4 py-2 text-base ${
                  activeList === 'allow'
                    ? ''
                    : 'border border-nb-line bg-nb-tile-2 text-nb-ink-2 shadow-none hover:bg-nb-tile hover:text-nb-ink'
                }`}>
                {t('options_firewall_allowList_header')}
              </Button>
              <Button
                onClick={() => setActiveList('deny')}
                className={`px-4 py-2 text-base ${
                  activeList === 'deny'
                    ? ''
                    : 'border border-nb-line bg-nb-tile-2 text-nb-ink-2 shadow-none hover:bg-nb-tile hover:text-nb-ink'
                }`}>
                {t('options_firewall_denyList_header')}
              </Button>
            </div>
          </div>

          <div className="mb-4 flex space-x-2">
            <input
              id="url-input"
              type="text"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  handleAddUrl();
                }
              }}
              placeholder={t('options_firewall_placeholders_domainUrl')}
              className={`flex-1 rounded-md border border-nb-line bg-nb-tile-2 px-3 py-2 text-sm text-nb-ink focus:border-nb-llm focus:outline-none`}
            />
            <Button onClick={handleAddUrl} className="px-4 py-2 text-sm">
              {t('options_firewall_btnAdd')}
            </Button>
          </div>
          {notice && (
            <p role="status" className="-mt-2 mb-4 text-sm text-nb-ink-2">
              {notice}
            </p>
          )}

          <div className="max-h-64 overflow-y-auto">
            {activeList === 'allow' ? (
              allowList.length > 0 ? (
                <ul className="space-y-2">
                  {allowList.map(url => (
                    <li
                      key={url}
                      className={`flex items-center justify-between rounded-md border border-nb-hair bg-nb-tile-2 p-2 pr-0`}>
                      <span className={`text-sm text-nb-ink`}>{url}</span>
                      <Button
                        onClick={() => handleRemoveUrl(url, 'allow')}
                        variant="danger"
                        className="rounded-l-none px-2 py-1 text-xs">
                        {t('options_firewall_btnRemove')}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={`text-center text-sm text-nb-muted`}>{t('options_firewall_allowList_empty')}</p>
              )
            ) : denyList.length > 0 ? (
              <ul className="space-y-2">
                {denyList.map(url => (
                  <li
                    key={url}
                    className={`flex items-center justify-between rounded-md border border-nb-hair bg-nb-tile-2 p-2 pr-0`}>
                    <span className={`text-sm text-nb-ink`}>{url}</span>
                    <Button
                      onClick={() => handleRemoveUrl(url, 'deny')}
                      variant="danger"
                      className="rounded-l-none px-2 py-1 text-xs">
                      {t('options_firewall_btnRemove')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`text-center text-sm text-nb-muted`}>{t('options_firewall_denyList_empty')}</p>
            )}
          </div>
        </div>
      </div>

      <div className={`rounded-xl border border-nb-line bg-nb-tile p-6 text-left shadow-nb`}>
        <h2 className={`mb-4 text-base font-semibold tracking-tight text-nb-ink`}>
          {t('options_firewall_howItWorks_header')}
        </h2>
        <ul className={`list-disc space-y-2 pl-5 text-left text-sm text-nb-ink-2`}>
          {t('options_firewall_howItWorks')
            .split('\n')
            .map((rule, index) => (
              <li key={index}>{rule}</li>
            ))}
        </ul>
      </div>
    </section>
  );
};
