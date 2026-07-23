import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import mark from '../../assets/bankai-mark.svg';
import { enterBlur, enterFade, staggerParent, tapScale, viewportOnce } from '../../lib/animations';

export default function FinalCta() {
  const reduceMotion = useReducedMotion();
  const enter = reduceMotion ? enterFade : enterBlur;

  return (
    <section className="ldg-final">
      <motion.div
        className="ldg-final-inner"
        variants={staggerParent}
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
      >
        <motion.div variants={enter}>
          <img src={mark} alt="" className="ldg-final-mark" />
        </motion.div>
        <motion.h2 className="ldg-final-title" variants={enter}>
          Release the final form of your remediation loop.
        </motion.h2>
        <motion.div variants={enter}>
          <motion.span whileTap={reduceMotion ? undefined : tapScale} className="ldg-inline-block">
            <Link to="/signup" className="ldg-btn-primary ldg-btn-large">
              Get started
            </Link>
          </motion.span>
        </motion.div>
      </motion.div>
    </section>
  );
}
