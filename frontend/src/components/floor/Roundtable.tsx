"use client";

interface Participant {
  username: string;
  color: string;
  isSpeaking: boolean;
}

interface RoundtableProps {
  participants: Participant[];
  isPlaying: boolean;
}

export function Roundtable({ participants, isPlaying }: RoundtableProps) {
  const count = participants.length;
  const tableRadius = Math.max(40, Math.min(70, 25 + count * 8));
  const seatRadius = tableRadius + 30;
  const viewSize = (seatRadius + 28) * 2;
  const center = viewSize / 2;

  return (
    <div className="flex justify-center py-4">
      <svg
        width={viewSize}
        height={viewSize}
        viewBox={`0 0 ${viewSize} ${viewSize}`}
        className="overflow-visible"
      >
        {/* Table surface */}
        <circle
          cx={center}
          cy={center}
          r={tableRadius}
          fill="#1a1a1a"
          stroke="#333"
          strokeWidth="2"
        />
        {/* Table inner highlight */}
        <circle
          cx={center}
          cy={center}
          r={tableRadius - 8}
          fill="none"
          stroke="#2a2a2a"
          strokeWidth="1"
        />

        {/* Seats around the table */}
        {participants.map((p, i) => {
          const angle = (2 * Math.PI * i) / count - Math.PI / 2;
          const x = center + seatRadius * Math.cos(angle);
          const y = center + seatRadius * Math.sin(angle);

          // Line from seat to table edge
          const tableEdgeX = center + tableRadius * Math.cos(angle);
          const tableEdgeY = center + tableRadius * Math.sin(angle);

          return (
            <g key={p.username}>
              {/* Connection line to table */}
              <line
                x1={tableEdgeX}
                y1={tableEdgeY}
                x2={x}
                y2={y}
                stroke={p.isSpeaking ? "#22c55e" : "#333"}
                strokeWidth="1"
                strokeDasharray={p.isSpeaking ? "none" : "2,2"}
              />

              {/* Speaking glow ring */}
              {p.isSpeaking && (
                <>
                  <circle
                    cx={x}
                    cy={y}
                    r="24"
                    fill="none"
                    stroke="#22c55e"
                    strokeWidth="2"
                    opacity="0.4"
                  >
                    <animate
                      attributeName="r"
                      values="24;28;24"
                      dur="1.5s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.4;0.1;0.4"
                      dur="1.5s"
                      repeatCount="indefinite"
                    />
                  </circle>
                  <circle
                    cx={x}
                    cy={y}
                    r="20"
                    fill="none"
                    stroke="#22c55e"
                    strokeWidth="2"
                  />
                </>
              )}

              {/* Avatar circle */}
              <circle
                cx={x}
                cy={y}
                r="18"
                fill={p.isSpeaking ? "#1a3a1a" : "#262626"}
                stroke={p.isSpeaking ? "#22c55e" : "#444"}
                strokeWidth={p.isSpeaking ? "2" : "1.5"}
              />

              {/* Avatar initials */}
              <text
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="11"
                fontWeight="600"
                fill={p.isSpeaking ? "#22c55e" : "#888"}
                className="select-none"
              >
                {p.username.slice(0, 2).toUpperCase()}
              </text>

              {/* Username label */}
              <text
                x={x}
                y={y + 28}
                textAnchor="middle"
                fontSize="8"
                fill={p.isSpeaking ? "#22c55e" : "#666"}
                className="select-none"
              >
                {p.username.length > 10
                  ? p.username.slice(0, 9) + "…"
                  : p.username}
              </text>
            </g>
          );
        })}

        {/* Center label */}
        {isPlaying && (
          <g>
            <circle cx={center} cy={center} r="4" fill="#22c55e">
              <animate
                attributeName="r"
                values="3;5;3"
                dur="1s"
                repeatCount="indefinite"
              />
            </circle>
          </g>
        )}
      </svg>
    </div>
  );
}
