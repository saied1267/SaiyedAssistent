
import React, { useEffect, useRef } from 'react';

interface VoiceVisualizerProps {
  isActive: boolean;
  isSpeaking: boolean;
  volume: number;
}

const VoiceVisualizer: React.FC<VoiceVisualizerProps> = ({ isActive, isSpeaking, volume }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      const baseRadius = 80;
      
      // Dynamic radius based on volume
      const pulse = isActive ? (volume * 50) : 0;
      const radius = baseRadius + pulse;

      // Glow effect
      const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius + 40);
      if (isSpeaking) {
        gradient.addColorStop(0, 'rgba(59, 130, 246, 0.5)'); // Blue
        gradient.addColorStop(1, 'transparent');
      } else if (isActive) {
        gradient.addColorStop(0, 'rgba(139, 92, 246, 0.3)'); // Purple
        gradient.addColorStop(1, 'transparent');
      } else {
        gradient.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
        gradient.addColorStop(1, 'transparent');
      }

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius + 40, 0, Math.PI * 2);
      ctx.fill();

      // Main Circle
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fillStyle = isSpeaking ? '#3b82f6' : (isActive ? '#8b5cf6' : '#333');
      ctx.shadowBlur = 20;
      ctx.shadowColor = isSpeaking ? '#3b82f6' : (isActive ? '#8b5cf6' : '#000');
      ctx.fill();
      ctx.shadowBlur = 0;

      // Inner circles/waves
      if (isActive) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
          const r = radius + (Math.sin(Date.now() / 200 + i) * 10);
          ctx.beginPath();
          ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      requestRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isActive, isSpeaking, volume]);

  return (
    <canvas 
      ref={canvasRef} 
      width={400} 
      height={400} 
      className="max-w-full h-auto"
    />
  );
};

export default VoiceVisualizer;
