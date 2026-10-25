import { useEffect, useState } from 'react';
import { setSiteLang, useSiteLang } from '../i18n/lang';
import { getSiteContent, site, withBase } from '../content/site';

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`nav${scrolled ? ' nav--scrolled' : ''}`}>
      <div className="container nav__inner">
        <a className="nav__brand" href="#top" aria-label={c.ui.nav.homeAria}>
          <img src={withBase('assets/favicon.svg')} alt="" width={26} height={26} />
          <span>DB Kit</span>
        </a>
        <nav className="nav__links" aria-label={c.ui.nav.navAria}>
          {c.ui.nav.links.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className="nav__actions">
          <button
            type="button"
            className="nav__lang"
            aria-label={c.ui.nav.langAriaOn}
            onClick={() => setSiteLang(lang === 'zh' ? 'en' : 'zh')}
          >
            {lang === 'zh' ? 'EN' : '中文'}
          </button>
          <a className="nav__github" href={site.urls.repo} target="_blank" rel="noreferrer" aria-label={c.ui.nav.githubAria}>
            <GitHubIcon />
            <span>GitHub</span>
          </a>
          <a className="btn btn--primary btn--sm" href={site.urls.marketplace} target="_blank" rel="noreferrer">
            {c.ui.nav.install}
          </a>
        </div>
      </div>
    </header>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
