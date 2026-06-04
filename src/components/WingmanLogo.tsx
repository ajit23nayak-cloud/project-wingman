type Props = {
  size?: number;
  color?: string;
  className?: string;
};

export function WingmanLogo({ size = 38, color = "#c4783d", className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="20" cy="20" r="19" stroke={color} strokeWidth="1.5" />
      <path
        d="M 8 26 Q 14 14, 20 20 Q 26 26, 32 14"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="20" cy="20" r="2.5" fill={color} />
    </svg>
  );
}
