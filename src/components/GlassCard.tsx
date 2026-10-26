import React from 'react';

export interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  as?: 'section' | 'div' | 'article' | 'aside';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  elevated?: boolean;
}

const PADDING_MAP: Record<NonNullable<GlassCardProps['padding']>, string> = {
  none: '',
  sm: 'p-3.5',
  md: 'p-5',
  lg: 'p-6',
};

/**
 * Spatial Glassmorphic functional container (`backdrop-filter: blur(28px) saturate(190%)`,
 * 24px radius, 1px specular border highlight). Respects reduced-transparency & high-contrast
 * user preferences automatically via `.glass-surface` in `index.css`.
 */
export const GlassCard = React.forwardRef<HTMLDivElement, GlassCardProps>(
  ({ as: Component = 'div', padding = 'md', elevated = false, className = '', children, ...rest }, ref) => {
    const surfaceClass = elevated ? 'glass-pill' : 'glass-surface';
    return (
      <Component
        ref={ref as React.Ref<HTMLDivElement>}
        className={`${surfaceClass} rounded-glass ${PADDING_MAP[padding]} ${className}`.trim()}
        {...rest}
      >
        {children}
      </Component>
    );
  },
);

GlassCard.displayName = 'GlassCard';
