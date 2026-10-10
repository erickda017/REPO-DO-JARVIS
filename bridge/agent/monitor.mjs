import nodeOs from 'node:os'
import { isWindows, ps, psJson } from './winps.mjs'

const GB = 2 ** 30
const r1 = (n) => Math.round(n * 10) / 10

/**
 * Real Windows metrics, on demand, plus a small in-memory history.
 *
 * The sampler is one 10-second timer inside the bridge that reads two numbers from Node's own `os` module
 * (no child process); it keeps the last hour. Anything heavier (per-process lists, disks, temperatures,
 * disk activity) runs only when asked. Every result says where it came from, and a metric the machine cannot give
 * is reported as unavailable with the reason, never as a made-up number.
 */
export function createMonitor({ clock = Date.now, os = nodeOs, run = psJson, runText = ps, intervalMs = 10_000, keep = 360 } = {}) {
  const history = []
  let prev = null
  let timer = null

  const cpuTimes = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }), { idle: 0, total: 0 })

  function sample() {
    const now = cpuTimes()
    let cpu = null
    if (prev) {
      const dt = now.total - prev.total
      if (dt > 0) cpu = (1 - (now.idle - prev.idle) / dt) * 100
    }
    prev = now
    const total = os.totalmem(), free = os.freemem()
    const s = { t: clock(), cpu: cpu == null ? null : r1(cpu), memUsedGB: r1((total - free) / GB), memUsedPct: r1(((total - free) / total) * 100) }
    if (cpu != null) {
      history.push(s)
      if (history.length > keep) history.shift()
    }
    return s
  }

  return {
    start() {
      if (timer) return
      sample()
      timer = setInterval(sample, intervalMs)
      timer.unref?.()
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
    sample,
    history: () => history.slice(),

    /** Averages over the last `minutes`, limited to what was actually recorded since the monitor started. */
    report(minutes = 30) {
      const from = clock() - minutes * 60_000
      const rows = history.filter((h) => h.t >= from)
      if (rows.length === 0) return { available: false, reason: 'Ainda não há amostras: o monitor acabou de iniciar.' }
      const cpu = rows.map((r) => r.cpu), mem = rows.map((r) => r.memUsedPct)
      const avg = (a) => r1(a.reduce((x, y) => x + y, 0) / a.length)
      const coverage = r1((rows.at(-1).t - rows[0].t) / 60_000)
      return {
        available: true,
        source: 'medido (Node os.cpus / os.freemem, uma amostra a cada 10 s)',
        requestedMinutes: minutes,
        coveredMinutes: coverage,
        note: coverage + 0.5 < minutes ? `Só há ${coverage} min de histórico desde que o JARVIS iniciou; o pedido foi de ${minutes} min.` : null,
        samples: rows.length,
        cpu: { avgPct: avg(cpu), maxPct: Math.max(...cpu), minPct: Math.min(...cpu) },
        memory: { avgUsedPct: avg(mem), maxUsedPct: Math.max(...mem), totalGB: r1(os.totalmem() / GB) },
      }
    },

    summary() {
      const total = os.totalmem(), free = os.freemem()
      const last = history.at(-1)
      return {
        source: 'medido',
        cpu: { model: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length, usagePct: last?.cpu ?? null, note: last ? null : 'sem amostra ainda' },
        memory: { totalGB: r1(total / GB), usedGB: r1((total - free) / GB), freeGB: r1(free / GB), usedPct: r1(((total - free) / total) * 100), note: 'RAM livre = física não usada; o Windows também mantém cache em "standby", que é reaproveitado e não é consumo de aplicativos.' },
        uptimeHours: r1(os.uptime() / 3600),
        os: `${os.type()} ${os.release()}`,
      }
    },

    async disks() {
      if (!isWindows) return []
      const d = await run('Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress', { timeoutMs: 15000 })
      return [].concat(d ?? []).filter((x) => x.Size > 2 ** 30).map((x) => ({
        drive: x.DeviceID, label: x.VolumeName || '', totalGB: r1(x.Size / GB), freeGB: r1(x.FreeSpace / GB), usedGB: r1((x.Size - x.FreeSpace) / GB), freePct: x.Size ? r1((x.FreeSpace / x.Size) * 100) : null,
      }))
    },

    /** Busy % and throughput of the physical disks over one second (a real counter reading). */
    async diskActivity() {
      if (!isWindows) return { available: false, reason: 'só no Windows' }
      try {
        // WMI class names do not change with the Windows language (the Get-Counter paths do, e.g. "Disco Físico" in pt-BR).
        const o = await run("$d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -eq '_Total' }; [pscustomobject]@{busy=[double]$d.PercentDiskTime; bps=[double]$d.DiskBytesPersec} | ConvertTo-Json -Compress", { timeoutMs: 15000 })
        return { available: true, source: 'WMI PerfDisk.PhysicalDisk(_Total), leitura instantânea', busyPct: r1(Math.min(o.busy, 100)), mbPerSec: r1(o.bps / 2 ** 20) }
      } catch (e) {
        return { available: false, reason: e.message }
      }
    },

    /** Top processes by working set (RAM) or by CPU over a real one-second window. */
    async topProcesses(by = 'memory', n = 10) {
      if (!isWindows) return []
      const count = Math.min(Math.max(Number(n) || 10, 1), 40)
      const script =
        by === 'cpu'
          ? `$a=@{}; Get-Process | ForEach-Object { $a[$_.Id]=$_.CPU }; Start-Sleep -Milliseconds 1000; $n=[Environment]::ProcessorCount; Get-Process | Where-Object { $a.ContainsKey($_.Id) -and $_.CPU -ne $null } | ForEach-Object { [pscustomobject]@{Name=$_.ProcessName;Id=$_.Id;MemMB=[math]::Round($_.WorkingSet64/1MB);CpuPct=[math]::Round((($_.CPU-$a[$_.Id])/$n)*100,1);Title=$_.MainWindowTitle;Path=$_.Path} } | Sort-Object CpuPct -Descending | Select-Object -First ${count} | ConvertTo-Json -Compress`
          : `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${count} | ForEach-Object { [pscustomobject]@{Name=$_.ProcessName;Id=$_.Id;MemMB=[math]::Round($_.WorkingSet64/1MB);Title=$_.MainWindowTitle;Path=$_.Path} } | ConvertTo-Json -Compress`
      return [].concat((await run(script, { timeoutMs: 25000 })) ?? [])
    },

    /** Temperatures only when the PC really exposes them; otherwise say so and why. */
    async temperature() {
      const out = { cpu: { available: false }, gpu: { available: false } }
      if (!isWindows) return out
      try {
        const t = await run("Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1 -ExpandProperty CurrentTemperature | ConvertTo-Json -Compress", { timeoutMs: 10000 })
        if (typeof t === 'number' && t > 2000) out.cpu = { available: true, celsius: r1(t / 10 - 273.15), source: 'WMI MSAcpi_ThermalZoneTemperature (zona térmica da placa-mãe; pode não ser o núcleo da CPU)' }
      } catch (e) {
        out.cpu.reason = `WMI térmico indisponível (${e.message.slice(0, 80)}); muitas placas só expõem isso a um app de sensores, como o HWiNFO ou o LibreHardwareMonitor.`
      }
      if (!out.cpu.available) {
        try {
          const t = await run("Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | Select-Object -First 1 -ExpandProperty Temperature | ConvertTo-Json -Compress", { timeoutMs: 10000 })
          if (typeof t === 'number' && t > 200) out.cpu = { available: true, celsius: r1(t - 273.15), source: 'contador ThermalZoneInformation (zona térmica ACPI)' }
        } catch { /* keep the reason above */ }
      }
      try {
        const g = await runText('nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader', { timeoutMs: 8000 })
        const n = Number(g.split(/\r?\n/)[0])
        if (Number.isFinite(n)) out.gpu = { available: true, celsius: n, source: 'nvidia-smi' }
      } catch {
        out.gpu.reason = 'Sem nvidia-smi (placas AMD/Intel não expõem a temperatura por uma ferramenta nativa do Windows).'
      }
      return out
    },
  }
}
