import { site } from '../content/site';

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer__inner">
        <div className="footer__brand">
          <span>DB Kit</span>
          <p>在 VSCode 里搞定数据库的一切。</p>
        </div>
        <nav className="footer__links" aria-label="页脚链接">
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
            Bug 反馈
          </a>
          <a href={`${site.urls.repo}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
            License Apache-2.0
          </a>
          <a href={site.urls.docs} target="_blank" rel="noreferrer">
            设计文档
          </a>
        </nav>
      </div>
      <div className="container footer__meta">
        <p>© {new Date().getFullYear()} DB Kit · 基于 Apache-2.0 开源</p>
      </div>
    </footer>
  );
}
