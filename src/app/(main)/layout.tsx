import { AppShell } from "@/components/app-shell";
import { SplashScreen } from "@/components/splash-screen";

export default function MainLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SplashScreen />
      <AppShell>{children}</AppShell>
    </>
  );
}
