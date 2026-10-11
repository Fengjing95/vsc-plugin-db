import { screenshots, withBase } from '../content/site';
import { Reveal } from './Reveal';

export function Screenshots() {
  return (
    <section className="section" id="screenshots">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">界面一览</p>
            <h2>长在你的编辑器里</h2>
            <p className="section__sub">与 VSCode 深色主题同源的界面语言，无切换成本。</p>
          </header>
        </Reveal>
        <div className="shots__grid">
          {screenshots.map((s, i) => (
            <Reveal key={s.file} delay={(i % 2) * 90}>
              <figure className="shot">
                <div className="shot__bar" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <span>{s.title}</span>
                </div>
                <img
                  src={withBase(`assets/images/${s.file}`)}
                  alt={`DB Kit 界面：${s.title}`}
                  width={1600}
                  height={1000}
                  loading="lazy"
                  decoding="async"
                />
                <figcaption className="shot__caption">
                  <strong>{s.title}</strong>
                  <span>{s.desc}</span>
                </figcaption>
              </figure>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
