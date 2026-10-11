import { Nav } from './components/Nav';
import { Hero } from './components/Hero';
import { SupportMatrix } from './components/SupportMatrix';
import { Features } from './components/Features';
import { Screenshots } from './components/Screenshots';
import { ComingSoon } from './components/ComingSoon';
import { QuickStart } from './components/QuickStart';
import { Limits } from './components/Limits';
import { Footer } from './components/Footer';

export default function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <SupportMatrix />
        <Features />
        <Screenshots />
        <ComingSoon />
        <QuickStart />
        <Limits />
      </main>
      <Footer />
    </>
  );
}
