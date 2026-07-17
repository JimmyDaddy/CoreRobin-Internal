import { useRef } from "react";

export type SensorReadinessStatus =
  | "waiting"
  | "available"
  | "unsupported"
  | "unavailable";

export interface SensorReadiness {
  status: SensorReadinessStatus;
  lastSuccessfulAtMs: number | null;
}

export function useSensorReadiness({
  sampledAtMs,
  warmingUp,
  temperatureCelsius,
  batteryPresent,
  batteryPercent,
  batteryDetailsAvailable,
}: {
  sampledAtMs: number;
  warmingUp: boolean;
  temperatureCelsius: number | null;
  batteryPresent: boolean;
  batteryPercent: number | null;
  batteryDetailsAvailable: boolean;
}): {
  temperature: SensorReadiness;
  battery: SensorReadiness;
  batteryDetails: SensorReadiness;
} {
  const temperatureSuccess = useRef<number | null>(null);
  const batterySuccess = useRef<number | null>(null);
  const batteryDetailsSuccess = useRef<number | null>(null);
  if (temperatureCelsius !== null) temperatureSuccess.current = sampledAtMs;
  if (batteryPresent && batteryPercent !== null) batterySuccess.current = sampledAtMs;
  if (batteryPresent && batteryDetailsAvailable) batteryDetailsSuccess.current = sampledAtMs;

  return {
    temperature: readiness(
      temperatureCelsius !== null,
      warmingUp,
      temperatureSuccess.current,
      temperatureSuccess.current !== null ? true : null,
    ),
    battery: readiness(
      batteryPresent && batteryPercent !== null,
      warmingUp,
      batterySuccess.current,
      batteryPresent,
    ),
    batteryDetails: readiness(
      batteryPresent && batteryDetailsAvailable,
      warmingUp,
      batteryDetailsSuccess.current,
      batteryPresent ? true : false,
    ),
  };
}

export function readiness(
  available: boolean,
  warmingUp: boolean,
  lastSuccessfulAtMs: number | null,
  supported: boolean | null,
): SensorReadiness {
  if (available) return { status: "available", lastSuccessfulAtMs };
  if (warmingUp && lastSuccessfulAtMs === null) {
    return { status: "waiting", lastSuccessfulAtMs: null };
  }
  if (supported === false || (supported === null && lastSuccessfulAtMs === null)) {
    return { status: "unsupported", lastSuccessfulAtMs };
  }
  return { status: "unavailable", lastSuccessfulAtMs };
}
