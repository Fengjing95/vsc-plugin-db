import { limits, site } from '../content/site';
import { Reveal } from './Reveal';

/** 已知限制：诚实展示防差评；全文见仓库 CHANGELOG */
export function Limits() {
  return (
    <section className="section section--tight" id="limits">
      <div className="container">
        <Reveal>
          <div className="card limits">
            <h2>已知限制</h2>
            <ul>
              {limits.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p>
              完整口径见
              <a href={site.urls.changelog} target="_blank" rel="noreferrer">
                仓库 CHANGELOG
              </a>
              。
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
