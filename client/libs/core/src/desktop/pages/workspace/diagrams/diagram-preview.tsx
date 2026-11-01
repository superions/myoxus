type DiagramCatalogPreviewProps = {
  kind: string;
};

const Box = ({
  x,
  y,
  width,
  height,
  alternate = false,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  alternate?: boolean;
}) => (
  <rect
    x={x}
    y={y}
    width={width}
    height={height}
    rx="4"
    fill="currentColor"
    fillOpacity={alternate ? "0.16" : "0.09"}
  />
);

/** Fixed, non-interactive miniatures make diagram types scannable at a glance. */
export function DiagramCatalogPreview({ kind }: DiagramCatalogPreviewProps) {
  let content;

  switch (kind) {
    case "bpmn":
      content = (
        <>
          <rect x="6" y="7" width="108" height="68" rx="3" />
          <path d="M6 27h108" />
          <circle
            cx="22"
            cy="50"
            r="8"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <path d="M30 50h15m18 0h15m18 0h10" />
          <Box x={45} y={40} width={18} height={20} alternate />
          <path
            d="M87 40l10 10-10 10-10-10z"
            fill="currentColor"
            fillOpacity="0.09"
          />
        </>
      );
      break;
    case "flowchart":
      content = (
        <>
          <Box x={7} y={10} width={28} height={18} />
          <Box x={84} y={54} width={28} height={18} alternate />
          <path
            d="M60 28l14 13-14 13-14-13z"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <path d="M35 19h25v9M74 41h24v13M46 41H23v-13" />
        </>
      );
      break;
    case "swimlanes":
      content = (
        <>
          <rect x="7" y="8" width="106" height="66" rx="3" />
          <path d="M7 29h106M7 52h106M31 8v66" />
          <Box x={40} y={14} width={20} height={10} />
          <Box x={74} y={36} width={22} height={10} alternate />
          <path d="M60 19h19v17" />
        </>
      );
      break;
    case "sequence":
      content = (
        <>
          <Box x={8} y={7} width={28} height={14} />
          <Box x={84} y={7} width={28} height={14} alternate />
          <path d="M22 21v52M98 21v52M22 35h76M98 49H22M22 63h76M92 31l6 4-6 4M28 45l-6 4 6 4M92 59l6 4-6 4" />
        </>
      );
      break;
    case "state":
      content = (
        <>
          <circle
            cx="12"
            cy="40"
            r="5"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <Box x={30} y={28} width={28} height={24} />
          <Box x={78} y={28} width={28} height={24} alternate />
          <path d="M17 40h13M58 40h20M106 40h8M72 36l6 4-6 4" />
        </>
      );
      break;
    case "journey":
      content = (
        <>
          <path d="M11 57c18-38 32 18 49-16s30 20 49-16M11 67h98" />
          <circle
            cx="11"
            cy="57"
            r="5"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <circle
            cx="60"
            cy="41"
            r="5"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <circle
            cx="109"
            cy="25"
            r="5"
            fill="currentColor"
            fillOpacity="0.09"
          />
        </>
      );
      break;
    case "event-modeling":
      content = (
        <>
          <path d="M10 18h100M10 41h100M10 64h100" />
          <Box x={15} y={10} width={19} height={16} />
          <Box x={48} y={33} width={22} height={16} alternate />
          <Box x={84} y={56} width={20} height={16} />
          <path d="M34 18h14M70 41h14" />
        </>
      );
      break;
    case "architecture":
      content = (
        <>
          <rect x="7" y="8" width="106" height="66" rx="5" />
          <Box x={15} y={18} width={28} height={18} />
          <Box x={77} y={18} width={28} height={18} alternate />
          <Box x={46} y={51} width={28} height={16} />
          <path d="M43 27h34M29 36v23h17M91 36v23H74" />
        </>
      );
      break;
    case "class":
      content = (
        <>
          <Box x={12} y={12} width={37} height={55} />
          <path d="M12 29h37M12 47h37M21 21h19M19 37h23M19 55h17" />
          <Box x={72} y={19} width={37} height={42} alternate />
          <path d="M72 36h37M49 39h23" />
        </>
      );
      break;
    case "er":
      content = (
        <>
          <Box x={7} y={9} width={38} height={57} />
          <Box x={75} y={9} width={38} height={57} alternate />
          <path d="M7 27h38M75 27h38M14 36h23M14 47h18M82 36h22M82 47h18M45 38h30M51 33l-6 5 6 5M69 33l6 5-6 5" />
        </>
      );
      break;
    case "requirement":
      content = (
        <>
          <Box x={8} y={12} width={42} height={50} />
          <Box x={72} y={20} width={40} height={36} alternate />
          <path d="M15 25h28M15 35h22M15 45h25M50 37h22M65 32l7 5-7 5" />
        </>
      );
      break;
    case "git-graph":
      content = (
        <>
          <path d="M25 10v62M25 28c28 0 20 28 50 28h22M25 58c24 0 19-30 50-30h22" />
          <circle
            cx="25"
            cy="16"
            r="5"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <circle
            cx="75"
            cy="28"
            r="5"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <circle
            cx="75"
            cy="56"
            r="5"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <circle
            cx="25"
            cy="66"
            r="5"
            fill="currentColor"
            fillOpacity="0.16"
          />
        </>
      );
      break;
    case "packet":
      content = (
        <>
          <rect x="7" y="23" width="106" height="37" rx="2" />
          <rect
            x="8"
            y="24"
            width="24"
            height="35"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <rect
            x="32"
            y="24"
            width="33"
            height="35"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <path d="M32 23v37M65 23v37M89 23v37M19 16v7M48 16v7M77 16v7M101 16v7" />
        </>
      );
      break;
    case "gantt":
      content = (
        <>
          <path d="M27 10v62M27 20h84M27 36h84M27 52h84M27 68h84" />
          <Box x={35} y={14} width={32} height={10} />
          <Box x={55} y={30} width={45} height={10} alternate />
          <Box x={78} y={46} width={27} height={10} />
        </>
      );
      break;
    case "timeline":
      content = (
        <>
          <path d="M10 41h100M24 35V18M60 47v18M96 35V18" />
          <circle
            cx="24"
            cy="41"
            r="6"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <circle
            cx="60"
            cy="41"
            r="6"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <circle
            cx="96"
            cy="41"
            r="6"
            fill="currentColor"
            fillOpacity="0.09"
          />
        </>
      );
      break;
    case "kanban":
      content = (
        <>
          <rect x="7" y="8" width="106" height="66" rx="3" />
          <path d="M42 8v66M78 8v66" />
          <Box x={13} y={18} width={23} height={11} />
          <Box x={48} y={18} width={24} height={11} alternate />
          <Box x={48} y={36} width={24} height={11} alternate />
          <Box x={84} y={18} width={23} height={11} />
        </>
      );
      break;
    case "mindmap":
      content = (
        <>
          <Box x={43} y={31} width={34} height={20} />
          <Box x={4} y={10} width={26} height={15} alternate />
          <Box x={4} y={59} width={26} height={15} alternate />
          <Box x={90} y={10} width={26} height={15} />
          <Box x={90} y={59} width={26} height={15} />
          <path d="M43 41H29V18M43 41H29v25M77 41h14V18M77 41h14v25" />
        </>
      );
      break;
    case "block":
      content = (
        <>
          <Box x={8} y={9} width={36} height={26} />
          <Box x={76} y={9} width={36} height={26} alternate />
          <Box x={42} y={49} width={36} height={25} />
          <path d="M44 22h32M26 35v26h16M94 35v26H78" />
        </>
      );
      break;
    case "tree-view":
      content = (
        <>
          <path d="M14 11v57M14 21h23M14 41h23M14 61h23M37 21v12h22M37 41v12h22" />
          <Box x={59} y={25} width={43} height={14} />
          <Box x={59} y={45} width={43} height={14} alternate />
        </>
      );
      break;
    case "wardley":
      content = (
        <>
          <path d="M13 8v64h96M13 20l80 42M34 34l33 11 27 15" />
          <circle
            cx="34"
            cy="28"
            r="6"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <circle
            cx="67"
            cy="45"
            r="6"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <circle
            cx="94"
            cy="60"
            r="6"
            fill="currentColor"
            fillOpacity="0.09"
          />
        </>
      );
      break;
    case "cynefin":
      content = (
        <>
          <rect x="7" y="8" width="106" height="66" rx="5" />
          <path d="M60 8v66M7 41h106M20 20h18M80 20h20M20 58h17M80 58h20" />
          <circle
            cx="60"
            cy="41"
            r="10"
            fill="currentColor"
            fillOpacity="0.09"
          />
        </>
      );
      break;
    case "ishikawa":
      content = (
        <>
          <path d="M12 42h93l8-8M25 42L13 22M40 42L28 62M58 42L46 20M76 42L64 64M94 42L82 23" />
          <path d="M105 34l8 8-8 8z" fill="currentColor" fillOpacity="0.09" />
        </>
      );
      break;
    case "pie":
      content = (
        <>
          <circle
            cx="60"
            cy="41"
            r="30"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <path
            d="M60 41V11a30 30 0 0 1 26 45z"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <path d="M60 41l26 15" />
        </>
      );
      break;
    case "quadrant":
      content = (
        <>
          <path d="M10 70V10M10 70h100M60 10v60M10 40h100" />
          <circle
            cx="32"
            cy="23"
            r="5"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <circle
            cx="84"
            cy="55"
            r="5"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <circle
            cx="78"
            cy="26"
            r="5"
            fill="currentColor"
            fillOpacity="0.09"
          />
        </>
      );
      break;
    case "radar":
      content = (
        <>
          <path d="M60 7l34 25-13 40H39L26 32zM60 18l23 17-9 27H46L37 35zM60 7v65M26 32l55 40M94 32L39 72" />
          <path
            d="M60 18l18 20-9 22-25-5-7-20z"
            fill="currentColor"
            fillOpacity="0.09"
          />
        </>
      );
      break;
    case "sankey":
      content = (
        <>
          <path d="M9 16h15v18H9zM9 49h15v18H9zM96 25h15v32H96z" />
          <path
            d="M24 18c35 0 37 9 72 12v15C61 42 59 30 24 30z"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <path
            d="M24 51c35 0 37-10 72-12v15c-35 2-37 10-72 10z"
            fill="currentColor"
            fillOpacity="0.16"
          />
        </>
      );
      break;
    case "xy-chart":
      content = (
        <>
          <path d="M12 9v62h98M25 40l32-13 27-12 20 4" />
          <rect
            x="25"
            y="47"
            width="13"
            height="24"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <rect
            x="51"
            y="34"
            width="13"
            height="37"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <rect
            x="77"
            y="20"
            width="13"
            height="51"
            fill="currentColor"
            fillOpacity="0.09"
          />
        </>
      );
      break;
    case "treemap":
      content = (
        <>
          <rect x="7" y="8" width="106" height="66" rx="3" />
          <rect
            x="8"
            y="9"
            width="43"
            height="64"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <rect
            x="52"
            y="9"
            width="60"
            height="30"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <path d="M51 8v66M51 39h62M83 39v35" />
        </>
      );
      break;
    case "venn":
      content = (
        <>
          <circle
            cx="48"
            cy="41"
            r="29"
            fill="currentColor"
            fillOpacity="0.09"
          />
          <circle
            cx="72"
            cy="41"
            r="29"
            fill="currentColor"
            fillOpacity="0.16"
          />
        </>
      );
      break;
    default:
      content = (
        <>
          <Box x={12} y={18} width={32} height={25} />
          <Box x={76} y={39} width={32} height={25} alternate />
          <path d="M44 30h32v21" />
        </>
      );
  }

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 120 82"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {content}
    </svg>
  );
}
