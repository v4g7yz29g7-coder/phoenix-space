import { useState } from 'react';
import './LivingField.css';
export default function LivingField({ onActivate }) {
  const [isActive, setIsActive] = useState(false);
  const handleClick = () => {
    setIsActive(!isActive);
    if (onActivate) onActivate(!isActive);
  };
  return (
    <div className="living-field" onClick={handleClick}>
      <div className={`pulsar ${isActive ? 'active' : ''}`}>
        <div className="pulsar-core"></div>
        <div className="pulsar-ring ring-1"></div>
        <div className="pulsar-ring ring-2"></div>
      </div>
      <span className="living-label">ЖИВОЕ ПОЛЕ</span>
    </div>
  );
}
