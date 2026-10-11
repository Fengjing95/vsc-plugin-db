import { features } from '../content/site';
import { Reveal } from './Reveal';

export function Features() {
  return (
    <section className="section" id="features">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">功能亮点</p>
            <h2>为日常数据库工作流而造</h2>
            <p className="section__sub">从看结构、查数据到改数据、写 SQL，一条完整链路全部在编辑器内完成。</p>
          </header>
        </Reveal>
        <div className="features__grid">
          {features.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 90}>
              <article className="card feature">
                <span className="feature__icon" aria-hidden="true">
                  {f.icon}
                </span>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
