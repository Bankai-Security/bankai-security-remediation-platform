import { useEffect } from 'react';
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
  useEffect(() => {
    // The landing page is the only dark surface in the app; scope the page
    // background to <body> while mounted so overscroll areas match.
    document.body.classList.add('ldg-body');
    return () => document.body.classList.remove('ldg-body');
  }, []);

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
