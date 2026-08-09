export type MicOption = { value: string; label: string };

export function micOptionValue(deviceId: string): string {
  return deviceId ? `device:${deviceId}` : "default";
}

export function buildMicOptions(
  devices: ReadonlyArray<Pick<MediaDeviceInfo, "deviceId" | "label">>,
  defaultLabel: string,
  numberedLabel: (n: number) => string,
): MicOption[] {
  const uniqueDevices = Array.from(
    new Map(devices.filter((device) => device.deviceId).map((device) => [device.deviceId, device])).values(),
  );

  return [
    { value: "default", label: defaultLabel },
    ...uniqueDevices.map((device, index) => ({
      value: micOptionValue(device.deviceId),
      label: device.label || numberedLabel(index + 1),
    })),
  ];
}

export function selectedMicLabel(options: readonly MicOption[], deviceId: string, defaultLabel: string): string {
  return options.find((option) => option.value === micOptionValue(deviceId))?.label ?? defaultLabel;
}
