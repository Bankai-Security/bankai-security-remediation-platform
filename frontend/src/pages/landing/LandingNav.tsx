import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import mark from '../../assets/bankai-mark.svg';
import wordmark from '../../assets/bankai-wordmark.svg';
import { tapScale } from '../../lib/animations';

export default function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    // IntersectionObserver on a top sentinel instead of a scroll listener.
    const sentinel = document.getElementById('landing-top-sentinel');
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <header className={`ldg-nav ${scrolled ? 'ldg-nav-scrolled' : ''}`}>
      <div className="ldg-nav-inner">
        <a href="#top" className="ldg-nav-brand" aria-label="Bankai, back to top">
          <img src={mark} alt="" className="ldg-brand-mark" />
          <img src={wordmark} alt="Bankai" className="ldg-brand-wordmark" />
        </a>

        <div className="ldg-nav-actions">
          <Link to="/login" className="ldg-nav-login">
            Log in
          </Link>
          <motion.span whileTap={reduceMotion ? undefined : tapScale} className="ldg-inline-block">
            <Link to="/signup" className="ldg-btn-primary ldg-btn-nav">
              Get started
            </Link>
          </motion.span>
        </div>
      </div>
    </header>
  );
}
