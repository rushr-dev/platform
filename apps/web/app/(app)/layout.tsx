import { TopBar } from '@/components/terminal/topbar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
