import { CopyCommand } from './CopyCommand';
import { engines, heroShot, site, withBase } from '../content/site';
import { Reveal } from './Reveal';

export function Hero() {
  return (
    <section className="hero" id="top">
      <div className="container hero__inner">
        <Reveal>
          <p className="hero__badge">
            <span className="hero__badge-dot" aria-hidden="true" />
            开源 · 已上架 VSCode Marketplace · {site.version}
          </p>
        </Reveal>
        <Reveal delay={80}>
          <h1 className="hero__title">
            在 VSCode 里，<span className="grad-text">搞定数据库的一切</span>
          </h1>
        </Reveal>
        <Reveal delay={160}>
          <p className="hero__sub">{site.subTagline}</p>
        </Reveal>
        <Reveal delay={240}>
          <ul className="hero__engines" aria-label="支持的数据源">
            {engines.map((e) => (
              <li key={e.key}>
                <img src={e.logo} alt="" width={16} height={16} />
                {e.name}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={320}>
          <div className="hero__cta">
            <a className="btn btn--primary" href={site.urls.marketplace} target="_blank" rel="noreferrer">
              安装 DB Kit
            </a>
            <a className="btn btn--ghost" href={site.urls.releases} target="_blank" rel="noreferrer">
              下载 VSIX
            </a>
          </div>
          <div className="hero__cmd">
            <CopyCommand command={site.installCommand} />
          </div>
        </Reveal>
        <Reveal delay={400} className="hero__shot-wrap">
          <figure className="shot shot--hero">
            <div className="shot__bar" aria-hidden="true">
              <i />
              <i />
              <i />
              <span>{heroShot.title}</span>
            </div>
            <img
              src={withBase(`assets/images/${heroShot.file}`)}
              alt={`DB Kit 界面：${heroShot.title}`}
              width={1600}
              height={1000}
              fetchPriority="high"
            />
            <figcaption className="hero__shot-caption">{heroShot.desc}</figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  );
}
