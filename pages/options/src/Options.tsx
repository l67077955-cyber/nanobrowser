import { useEffect, useState } from 'react';
import '@src/Options.css';
import '@src/brutal.css';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { t } from '@extension/i18n';
import { FiSettings, FiCpu, FiShield, FiBookmark, FiLink } from 'react-icons/fi';
import { GeneralSettings } from './components/GeneralSettings';
import { ModelSettings } from './components/ModelSettings';
import { FirewallSettings } from './components/FirewallSettings';
import { MemorySettings } from './components/MemorySettings';
import { RemoteSettings } from './components/RemoteSettings';

type TabTypes = 'general' | 'models' | 'firewall' | 'memory' | 'remote';

const TABS: { id: TabTypes; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { id: 'general', icon: FiSettings, label: t('options_tabs_general') },
  { id: 'models', icon: FiCpu, label: t('options_tabs_models') },
  { id: 'firewall', icon: FiShield, label: t('options_tabs_firewall') },
  { id: 'memory', icon: FiBookmark, label: t('options_tabs_memory') },
  { id: 'remote', icon: FiLink, label: t('options_tabs_remote') },
];

const SECTIONS: Record<TabTypes, React.ComponentType> = {
  general: GeneralSettings,
  models: ModelSettings,
  firewall: FirewallSettings,
  memory: MemorySettings,
  remote: RemoteSettings,
};

/** All settings on one sheet; the index on the left jumps to a section and marks the one in view */
const Options = () => {
  const [current, setCurrent] = useState<TabTypes>('general');

  useEffect(() => {
    // a link to a section, e.g. options/index.html#models
    const wanted = window.location.hash.slice(1);
    if (TABS.some(tab => tab.id === wanted)) document.getElementById(wanted)?.scrollIntoView();

    const sections = TABS.map(tab => document.getElementById(tab.id)).filter((el): el is HTMLElement => !!el);
    // the section in view is the last one whose top has passed the upper third of the window
    const update = () => {
      const line = window.innerHeight / 3;
      let inView = sections[0]?.id;
      for (const section of sections) if (section.getBoundingClientRect().top <= line) inView = section.id;
      if (inView) setCurrent(inView as TabTypes);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <div className="nb-options flex min-h-screen min-w-[768px] bg-nb-page text-left text-nb-ink">
      <nav className="nb-opt-nav w-48 shrink-0">
        <div className="sticky top-0">
          <div className="nb-opt-brand">
            <img src="/icon-128.png" alt="" className="size-[18px]" />
            {t('options_nav_header')}
          </div>
          {TABS.map((item, index) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              aria-current={current === item.id || undefined}
              onClick={e => {
                e.preventDefault();
                document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth' });
                history.replaceState(null, '', `#${item.id}`);
              }}>
              <item.icon />
              <span>{item.label}</span>
              <small>{String(index + 1).padStart(2, '0')}</small>
            </a>
          ))}
        </div>
      </nav>

      <main className="flex-1 px-8">
        <div className="mx-auto min-w-[512px] max-w-screen-lg">
          {TABS.map(({ id }) => {
            const Section = SECTIONS[id];
            return (
              <section key={id} id={id} className="nb-opt-section">
                <Section />
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <div>Loading...</div>), <div>Error Occurred</div>);
