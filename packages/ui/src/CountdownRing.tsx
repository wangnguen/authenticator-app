interface Props {
  remaining: number;
  period: number;
  size?: number;
}

export function CountdownRing({ remaining, period, size = 28 }: Props) {
  const stroke = 3;
  const center = size / 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = period > 0 ? remaining / period : 0;
  const urgent = remaining <= 5;

  return (
    <svg
      className={urgent ? "auth-ring auth-ring--urgent" : "auth-ring"}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-label={`Còn ${remaining} giây`}
    >
      <circle
        className="auth-ring__track"
        cx={center}
        cy={center}
        r={radius}
        strokeWidth={stroke}
      />
      <circle
        className="auth-ring__bar"
        cx={center}
        cy={center}
        r={radius}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        transform={`rotate(-90 ${center} ${center})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle">
        {remaining}
      </text>
    </svg>
  );
}
