import React from "react";

export const Footer: React.FC = () => {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-branding">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-500 inline-block"></span>
          <span>ApexWall AI Engineering Platform</span>
        </div>
        <div className="footer-text">
          Calibrated baselines for competitive simulation. Validate tyre pressures and balance during live stints.
        </div>
        <div className="footer-text" style={{ marginTop: "8px", fontSize: "12px", opacity: 0.85 }}>
          Platform originally created and architected by{" "}
          <a
            href="https://github.com/octavia-23"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#7dd3fc", textDecoration: "underline" }}
          >
            Akshat Yadav (octavia-23)
          </a>
          . This deployment is a personal non-commercial fork for sim rig testing — see the{" "}
          <a
            href="https://github.com/octavia-23/ApexWall-ai"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#7dd3fc", textDecoration: "underline" }}
          >
            upstream repository
          </a>
          .
        </div>
        <div className="footer-meta">
          <span>Protocol v2.5</span>
          <span className="text-slate-600">/</span>
          <span>MoTeC Compliant</span>
        </div>
      </div>
    </footer>
  );
};
