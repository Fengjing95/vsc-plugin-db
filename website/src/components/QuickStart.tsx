import { quickStart, site } from '../content/site';
import { CopyCommand } from './CopyCommand';
import { Reveal } from './Reveal';

export function QuickStart() {
  return (
    <section className="section" id="quickstart">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">快速上手</p>
            <h2>30 秒，从安装到看到数据</h2>
          </header>
        </Reveal>
        <div className="qs__grid">
          <Reveal>
            <div className="card qs__install">
              <h3>
                第一步<span>安装（三选一）</span>
              </h3>
              <ol className="qs__install-list">
                {quickStart.install.map((w) => (
                  <li key={w.title}>
                    <strong>{w.title}</strong>
                    <span>{w.desc}</span>
                  </li>
                ))}
              </ol>
              <CopyCommand command={site.installCommand} />
              <a className="qs__releases" href={site.urls.releases} target="_blank" rel="noreferrer">
                前往 GitHub Releases 下载 VSIX <span aria-hidden="true">→</span>
              </a>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="qs__steps">
              {quickStart.steps.map((s, i) => (
                <div className="qs__step" key={s.title}>
                  <span className="qs__step-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div>
                    <h3>{s.title}</h3>
                    <p>{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
