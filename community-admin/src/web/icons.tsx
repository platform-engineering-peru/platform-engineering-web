import React from "react";
const youtubeLogo = new URL(
  "../../public/brand/providers/youtube.svg",
  import.meta.url,
).href;
const linkedinLogo = new URL(
  "../../public/brand/providers/linkedin.svg",
  import.meta.url,
).href;
const githubBlack = new URL(
  "../../public/brand/providers/github-black.svg",
  import.meta.url,
).href;
const githubWhite = new URL(
  "../../public/brand/providers/github-white.svg",
  import.meta.url,
).href;
import {
  LayoutDashboard,
  Layers,
  Users,
  BriefcaseBusiness,
  Send,
  Settings2,
  Search,
  Sun,
  Moon,
  ChevronDown,
  ChevronRight,
  LogOut,
  RefreshCw,
  X,
  Menu,
  ArrowUpRight,
  Image,
  BookOpen,
  CalendarDays,
  Building2,
  Mic,
  ShieldCheck,
  Clock3,
  Link2,
  ListChecks,
  History,
  Activity,
  CircleCheck,
  FileText,
  CircleHelp,
  Fingerprint,
  SlidersHorizontal,
  Filter,
  UserRound,
  Plus,
  Upload,
  Download,
  Inbox,
  Network,
  Palette,
  FolderOpen,
  Command,
  Laptop,
  Ellipsis,
  ArrowRight,
  ArrowLeft,
  Grid2X2,
  List,
  Globe,
  GraduationCap,
  HeartHandshake,
  Ban,
  Archive,
  ScanSearch,
  Radio,
  FileCheck2,
  MessageSquare,
  CircleDot,
  Check,
  type LucideIcon,
} from "lucide-react";
const icons: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  content: Layers,
  people: Users,
  jobs: BriefcaseBusiness,
  publish: Send,
  settings: Settings2,
  search: Search,
  sun: Sun,
  moon: Moon,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  logout: LogOut,
  refresh: RefreshCw,
  close: X,
  menu: Menu,
  external: ArrowUpRight,
  image: Image,
  resources: BookOpen,
  courses: GraduationCap,
  calendar: CalendarDays,
  organizations: Building2,
  speakers: Mic,
  shield: ShieldCheck,
  clock: Clock3,
  link: Link2,
  review: ListChecks,
  history: History,
  activity: Activity,
  check: Check,
  complete: CircleCheck,
  file: FileText,
  help: CircleHelp,
  identity: Fingerprint,
  controls: SlidersHorizontal,
  filter: Filter,
  user: UserRound,
  plus: Plus,
  upload: Upload,
  download: Download,
  inbox: Inbox,
  network: Network,
  palette: Palette,
  folder: FolderOpen,
  command: Command,
  local: Laptop,
  more: Ellipsis,
  arrowRight: ArrowRight,
  arrowLeft: ArrowLeft,
  grid: Grid2X2,
  list: List,
  globe: Globe,
  participation: HeartHandshake,
  excluded: Ban,
  archive: Archive,
  scan: ScanSearch,
  channel: Radio,
  approved: FileCheck2,
  message: MessageSquare,
  dot: CircleDot,
};
/** Decorative icons accompany visible labels; icon-only controls supply their own accessible name. */
export function AppIcon({
  name,
  size = 20,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  if (["youtube", "linkedin", "github"].includes(name))
    return <ProviderLogo provider={name} size={size} className={className} />;
  const Icon = icons[name] ?? FolderOpen;
  return (
    <Icon
      size={size}
      strokeWidth={1.7}
      aria-hidden="true"
      focusable="false"
      className={className}
    />
  );
}

/** Provider identity uses unchanged official marks, independently of generic action icons. */
export function ProviderLogo({
  provider,
  size = 20,
  className = "",
}: {
  provider: string;
  size?: number;
  className?: string;
}) {
  if (provider === "github")
    return (
      <span
        className={`provider-logo github-logo ${className}`}
        aria-hidden="true"
        style={{ width: size, height: size }}
      >
        <img
          className="provider-light"
          src={githubBlack}
          width={size}
          height={size}
          alt=""
        />
        <img
          className="provider-dark"
          src={githubWhite}
          width={size}
          height={size}
          alt=""
        />
      </span>
    );
  if (provider !== "youtube" && provider !== "linkedin")
    return <AppIcon name="calendar" size={size} className={className} />;
  return (
    <img
      className={`provider-logo ${className}`}
      src={provider === "youtube" ? youtubeLogo : linkedinLogo}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}
