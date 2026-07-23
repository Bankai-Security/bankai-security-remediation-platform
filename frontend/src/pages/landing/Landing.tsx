import LandingNav from './LandingNav';
import Hero from './Hero';
import IntegrationStrip from './IntegrationStrip';
import Pipeline from './Pipeline';
import FeatureBento from './FeatureBento';
import Trust from './Trust';
import SelfHost from './SelfHost';
import Faq from './Faq';
import FinalCta from './FinalCta';
import LandingFooter from './LandingFooter';
import './Landing.css';

export default function Landing() {
  // Light theme: the page shares the app's #F4F4F5 body background, so no
  // body-level override is needed (the old dark theme scoped one here).
  return (
    <div className="landing">
      <div id="landing-top-sentinel" aria-hidden="true" />
      <LandingNav />
      <main>
        <Hero />
        <IntegrationStrip />
        <Pipeline />
        <FeatureBento />
        <Trust />
        <SelfHost />
        <Faq />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
