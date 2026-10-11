import { comingSoon, site } from '../content/site';
import { Reveal } from './Reveal';

export function ComingSoon() {
  return (
    <section className="section" id="roadmap">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">Coming Soon</p>
            <h2>在路上，由你定优先级</h2>
            <p className="section__sub">
              以下驱动在规划中、尚未发布；想要哪个、急着用哪个，去 issue 说一句，你的声音直接决定开发顺序。
            </p>
          </header>
        </Reveal>
        <div className="coming__grid">
          {comingSoon.map((c, i) => (
            <Reveal key={c.name} delay={i * 90}>
              <article className="card coming__card">
                <div className="coming__badge">规划中</div>
                <h3>{c.name}</h3>
                <p>{c.desc}</p>
                {c.tags ? (
                  <ul className="coming__tags" aria-label="候选范围">
                    {c.tags.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                ) : null}
                <a
                  className="coming__link"
                  href={site.urls.roadmapIssue}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`期待 ${c.name}？去 issue 说一句`}
                >
                  期待它？去 issue 说一句 <span aria-hidden="true">→</span>
                </a>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
