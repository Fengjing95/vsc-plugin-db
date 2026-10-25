import { getSiteContent, site } from '../content/site';
import { setSiteLang, useSiteLang } from '../i18n/lang';

export function Footer() {
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  return (
    <footer className="footer">
      <div className="container footer__inner">
        <div className="footer__brand">
          <span>DB Kit</span>
          <p>{c.ui.footer.tagline}</p>
        </div>
        <nav className="footer__links" aria-label={c.ui.footer.linksAria}>
          <a href={site.urls.repo} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={site.urls.marketplace} target="_blank" rel="noreferrer">
            Marketplace
          </a>
          <a href={site.urls.issues} target="_blank" rel="noreferrer">
            Issues
          </a>
          <a href={site.urls.newBugIssue} target="_blank" rel="noreferrer">
            {c.ui.footer.bugFeedback}
          </a>
          <a href={`${site.urls.repo}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
            License Apache-2.0
          </a>
          <a href={site.urls.docs} target="_blank" rel="noreferrer">
            {c.ui.footer.designDocs}
          </a>
        </nav>
      </div>
      <div className="container footer__meta">
        <p>
          © {new Date().getFullYear()} DB Kit · {c.ui.footer.copyright}{' '}
          <button
            type="button"
            className="nav__lang"
            aria-label={c.ui.nav.langAriaOn}
            onClick={() => setSiteLang(lang === 'zh' ? 'en' : 'zh')}
          >
            {lang === 'zh' ? 'EN' : '中文'}
          </button>
        </p>
      </div>
    </footer>
  );
}
