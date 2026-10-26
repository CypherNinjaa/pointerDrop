import React from 'react';
import { useReducedMotion } from 'framer-motion';

export interface Point2D {
  x: number;
  y: number;
}

export interface ActiveTetherStream {
  id: string;
  target: Point2D;
  direction: 'send' | 'receive';
  channels: number;
  degraded: boolean;
}

export interface TetherLineProps {
  width: number;
  height: number;
  origin: Point2D;
  dragTarget: { x: number; y: number; snapped: boolean } | null;
  activeStreams: ActiveTetherStream[];
}

function buildQuadraticLanePath(from: Point2D, to: Point2D, normalOffset: number): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist;
  const ny = dx / dist;
  const cx = (from.x + to.x) * 0.5 + nx * normalOffset;
  const cy = (from.y + to.y) * 0.5 + ny * normalOffset;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

function buildElasticDragPath(from: Point2D, to: Point2D, snapped: boolean): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // Slack decreases as the tether snaps onto a peer node.
  const sag = snapped ? Math.min(10, dist * 0.04) : Math.min(42, dist * 0.16);
  const cx = (from.x + to.x) * 0.5;
  const cy = (from.y + to.y) * 0.5 + sag;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

const LANE_OFFSETS = [-15, -5, 5, 15] as const;

export const TetherLine: React.FC<TetherLineProps> = ({
  width,
  height,
  origin,
  dragTarget,
  activeStreams,
}) => {
  const reduceMotion = useReducedMotion();

  if (width <= 0 || height <= 0) return null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="pointer-events-none absolute inset-0 z-10 overflow-visible"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="warp-tether-cyan" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#0A84FF" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#64D2FF" stopOpacity="0.95" />
        </linearGradient>
        <linearGradient id="warp-tether-lime" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#0A84FF" stopOpacity="0.85" />
          <stop offset="50%" stopColor="#30D158" stopOpacity="1" />
          <stop offset="100%" stopColor="#30D158" stopOpacity="0.9" />
        </linearGradient>
        <filter id="warp-glow" x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Active 4-DataChannel Parallel Particle Streams */}
      {activeStreams.map((stream) => {
        const start = stream.direction === 'send' ? origin : stream.target;
        const end = stream.direction === 'send' ? stream.target : origin;
        const accentColor = stream.degraded ? '#FF9F0A' : '#30D158';

        return (
          <g key={stream.id}>
            {LANE_OFFSETS.map((offset, laneIdx) => {
              const laneActive = laneIdx < stream.channels;
              const pathId = `warp-lane-${stream.id}-${laneIdx}`;
              const d = buildQuadraticLanePath(start, end, offset);
              return (
                <g key={pathId}>
                  <path
                    id={pathId}
                    d={d}
                    fill="none"
                    stroke={laneActive ? accentColor : 'rgba(255,255,255,0.12)'}
                    strokeOpacity={laneActive ? 0.36 : 0.14}
                    strokeWidth={laneActive ? 1.6 : 1}
                    strokeDasharray={laneActive ? undefined : '4 5'}
                  />
                  {laneActive && !reduceMotion && (
                    <>
                      <circle r="3.2" fill={accentColor} filter="url(#warp-glow)">
                        <animateMotion
                          dur={`${(0.72 + laneIdx * 0.09).toFixed(2)}s`}
                          begin={`${(laneIdx * 0.14).toFixed(2)}s`}
                          repeatCount="indefinite"
                          path={d}
                        />
                      </circle>
                      <circle r="2.2" fill="#FFFFFF" fillOpacity="0.9">
                        <animateMotion
                          dur={`${(0.72 + laneIdx * 0.09).toFixed(2)}s`}
                          begin={`${(laneIdx * 0.14 + 0.36).toFixed(2)}s`}
                          repeatCount="indefinite"
                          path={d}
                        />
                      </circle>
                    </>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}

      {/* Live Interactive Pointer-Drag Elastic Tether */}
      {dragTarget && (
        <g>
          <path
            d={buildElasticDragPath(origin, dragTarget, dragTarget.snapped)}
            fill="none"
            stroke={dragTarget.snapped ? 'url(#warp-tether-lime)' : 'url(#warp-tether-cyan)'}
            strokeWidth={dragTarget.snapped ? 3 : 2.2}
            strokeLinecap="round"
            strokeDasharray={dragTarget.snapped ? undefined : '6 5'}
            filter="url(#warp-glow)"
          />
          <circle
            cx={dragTarget.x}
            cy={dragTarget.y}
            r={dragTarget.snapped ? 9 : 6}
            fill={dragTarget.snapped ? '#30D158' : '#0A84FF'}
            fillOpacity={0.28}
            stroke={dragTarget.snapped ? '#30D158' : '#64D2FF'}
            strokeWidth={1.75}
          />
          <circle
            cx={dragTarget.x}
            cy={dragTarget.y}
            r={3}
            fill="#FFFFFF"
          />
        </g>
      )}
    </svg>
  );
};
