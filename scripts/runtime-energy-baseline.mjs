export const runtimeEnergyScenarios = [
  {
    id: "foreground",
    defaultDurationSeconds: 300,
    instruction: "保持 CoreRobin 主窗口可见，停留在概览页并等待界面稳定。",
  },
  {
    id: "hidden",
    defaultDurationSeconds: 600,
    instruction: "关闭或隐藏主窗口，保留 CoreRobin 在后台运行，不打开状态栏面板。",
  },
  {
    id: "tray",
    defaultDurationSeconds: 120,
    instruction: "保持主窗口关闭，打开状态栏面板并让它停留在屏幕上。",
  },
];

export function summarizeEnergySamples(samples, pid, memorySamples = []) {
  const tasks = samples.flatMap((sample) => Array.isArray(sample.tasks) ? sample.tasks : []);
  const matching = tasks.filter((task) => Number(task.pid) === Number(pid));
  const rssValues = memorySamples
    .map((sample) => Number(sample.rssBytes))
    .filter(Number.isFinite);
  const psCpuValues = memorySamples
    .map((sample) => Number(sample.cpuPercent))
    .filter(Number.isFinite);
  const cpuMsPerSecond = numericValues(matching, ["cputime_ms_per_s", "cpu_ms_per_s"]);
  const interruptWakeups = numericValues(matching, ["intr_wakeups_per_s", "interrupt_wakeups_per_s"]);
  const packageIdleWakeups = numericValues(matching, ["idle_wakeups_per_s", "package_idle_wakeups_per_s"]);
  const energyImpact = numericValues(matching, ["energy_impact", "energyImpact"]);

  return {
    powermetricsSampleCount: matching.length,
    memorySampleCount: rssValues.length,
    cpuPercent: statistic(cpuMsPerSecond.map((value) => value / 10)),
    psCpuPercent: statistic(psCpuValues),
    interruptWakeupsPerSecond: statistic(interruptWakeups),
    packageIdleWakeupsPerSecond: statistic(packageIdleWakeups),
    residentMemoryBytes: statistic(rssValues),
    energyImpact: statistic(energyImpact),
  };
}

function numericValues(items, keys) {
  return items.flatMap((item) => {
    for (const key of keys) {
      const value = Number(item[key]);
      if (Number.isFinite(value)) return [value];
    }
    return [];
  });
}

function statistic(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    minimum: ordered[0],
    maximum: ordered.at(-1),
    p95: ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)],
  };
}
