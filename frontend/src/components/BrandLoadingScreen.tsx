import bankaiMark from '../assets/bankai-mark.svg';

export default function BrandLoadingScreen() {
  return (
    <div className="bankai-loading-screen" role="status" aria-label="Loading Bankai">
      <img className="bankai-loading-mark" src={bankaiMark} alt="" />
    </div>
  );
}
