type AppToastProps = {
  message: string | null;
};

export function AppToast({ message }: AppToastProps) {
  if (!message) {
    return null;
  }

  return <div className="app-toast bg-kumo-elevated border-kumo-line text-kumo-default">{message}</div>;
}
