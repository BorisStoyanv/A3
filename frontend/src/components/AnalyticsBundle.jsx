import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const ADMIN_CHART_COLORS = {
  signups: "#81A8FF",
  projects: "#B48AF7",
  deployments: "#8FA5B7",
  succeeded: "#59D997",
  failed: "#F27C88",
  grid: "rgba(255,255,255,0.08)",
  axis: "rgba(218,222,230,0.72)",
};

function projectMatchesDeployment(project, deployment) {
  if (!project || !deployment) {
    return false;
  }
  return deployment.project?.id === project.id || deployment.projectId === project.id;
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function ActivityEmptyIcon() {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="13.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M14 24h6l3-5 4 10 3-5h4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BuildEmptyIcon() {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="26" r="13.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M24 9v4m-4-4h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M24 26l6-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ChartEmptyState({ icon, text, className = "" }) {
  const classes = ["chart-empty-state", className].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <span className="empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <p>{text}</p>
    </div>
  );
}

function ActivityTooltip({ active, payload }) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="chart-tooltip-card">
      <strong>{point.label}</strong>
      <span>Runs: {point.total}</span>
      <span>Succeeded: {point.succeeded}</span>
      <span>Failed: {point.failed}</span>
    </div>
  );
}

function DeploymentActivityCard({ deployments, project }) {
  const points = useMemo(() => {
    if (!project) return [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const buckets = Array.from({ length: 7 }, (_, idx) => {
      const day = new Date(now);
      day.setDate(day.getDate() - (6 - idx));
      return {
        ts: day.getTime(),
        label: day.toLocaleDateString(undefined, { month: "short", day: "2-digit" }),
        total: 0,
        succeeded: 0,
        failed: 0,
      };
    });
    const byTs = new Map(buckets.map((bucket) => [bucket.ts, bucket]));
    (deployments || [])
      .filter((item) => projectMatchesDeployment(project, item))
      .forEach((item) => {
        const createdAt = Number(item.createdAt);
        if (!Number.isFinite(createdAt)) return;
        const day = new Date(createdAt);
        day.setHours(0, 0, 0, 0);
        const bucket = byTs.get(day.getTime());
        if (!bucket) return;
        bucket.total += 1;
        const status = String(item.status || "").toLowerCase();
        if (status.includes("succeed")) {
          bucket.succeeded += 1;
        } else if (status.includes("fail") || status.includes("error")) {
          bucket.failed += 1;
        }
      });
    return buckets;
  }, [deployments, project]);

  const totalRuns = points.reduce((sum, point) => sum + point.total, 0);
  const totalSuccess = points.reduce((sum, point) => sum + point.succeeded, 0);
  const successRate = totalRuns > 0 ? Math.round((totalSuccess / totalRuns) * 100) : 0;
  const hasRuns = totalRuns > 0;

  return (
    <section className="card graph-card modern">
      <div className="card-head">
        <div className="graph-title">
          <h2>Deployment Activity</h2>
          <span className="muted">Last 7 days</span>
        </div>
        <span className="graph-pill">{totalRuns} runs</span>
      </div>
      {hasRuns ? (
        <div className="activity-chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="activityLineGradient" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#8b5cf6" />
                  <stop offset="55%" stopColor="#ec4899" />
                  <stop offset="100%" stopColor="#f97316" />
                </linearGradient>
                <linearGradient id="activityAreaGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgba(139, 92, 246, 0.1)" />
                  <stop offset="100%" stopColor="rgba(139, 92, 246, 0.01)" />
                </linearGradient>
                <linearGradient id="activityFailGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgba(168, 176, 194, 0.18)" />
                  <stop offset="100%" stopColor="rgba(168, 176, 194, 0.01)" />
                </linearGradient>
              </defs>
              <CartesianGrid
                vertical={false}
                stroke={ADMIN_CHART_COLORS.grid}
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tick={{ fill: ADMIN_CHART_COLORS.axis, fontSize: 11 }}
              />
              <YAxis
                width={30}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                tick={{ fill: ADMIN_CHART_COLORS.axis, fontSize: 11 }}
              />
              <Tooltip
                content={<ActivityTooltip />}
                cursor={{ stroke: "rgba(255,255,255,0.18)", strokeWidth: 1 }}
              />
              <Area
                type="monotone"
                dataKey="failed"
                stroke="rgba(176, 184, 198, 0.68)"
                fill="url(#activityFailGradient)"
                strokeWidth={1.7}
                isAnimationActive
                animationDuration={360}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke="url(#activityLineGradient)"
                fill="url(#activityAreaGradient)"
                strokeWidth={2}
                isAnimationActive
                animationDuration={420}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <ChartEmptyState icon={<ActivityEmptyIcon />} text="No deployments in the last 7 days" />
      )}
      {hasRuns ? (
        <div className="graph-meta">
          <span>
            Success rate: <strong>{successRate}%</strong>
          </span>
          <span className={successRate >= 70 ? "trend up" : "trend down"}>
            {totalSuccess} successful deployments
          </span>
        </div>
      ) : null}
    </section>
  );
}

function BuildDurationTooltip({ active, payload }) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  const deltaText =
    point.deltaFromPrev == null
      ? "First run in range"
      : `${point.deltaFromPrev > 0 ? "+" : ""}${point.deltaFromPrev}s vs previous`;
  return (
    <div className="chart-tooltip-card">
      <strong>{point.seconds}s</strong>
      <span>{point.name}</span>
      <span>{formatDate(point.createdAt)}</span>
      <span>{deltaText}</span>
    </div>
  );
}

function BuildDurationCard({ deployments, project }) {
  const scopedDeployments = useMemo(() => {
    const list = (deployments || []).filter((item) => {
      if (!project) return false;
      const okStatus = String(item.status || "")
        .toLowerCase()
        .includes("succeed");
      if (!okStatus) return false;
      return projectMatchesDeployment(project, item);
    });
    return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [deployments, project]);

  const points = useMemo(
    () =>
      scopedDeployments
        .map((item) => {
          const durationFromMs = Number.isFinite(item.durationMs) ? item.durationMs : null;
          const durationFromTimes =
            item.finishedAt &&
            item.startedAt &&
            Number.isFinite(item.finishedAt) &&
            Number.isFinite(item.startedAt)
              ? Math.max(0, item.finishedAt - item.startedAt)
              : null;
          const resolved = durationFromMs ?? durationFromTimes;
          return { ...item, __duration: resolved };
        })
        .filter((item) => Number.isFinite(item.__duration))
        .slice(0, 14)
        .reverse()
        .map((item, idx, arr) => {
          const seconds = Math.max(1, Math.round(item.__duration / 1000));
          const prevSeconds = idx > 0 ? arr[idx - 1].__duration / 1000 : null;
          return {
            name: item.createdAt
              ? new Date(item.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "2-digit",
                })
              : `Run ${String(idx + 1).padStart(2, "0")}`,
            seconds,
            run: idx + 1,
            deltaFromPrev:
              prevSeconds == null ? null : Math.round((seconds - prevSeconds) * 10) / 10,
            createdAt: item.createdAt || null,
          };
        }),
    [scopedDeployments],
  );

  if (!points.length) {
    return (
      <section className="card graph-card">
        <div className="card-head">
          <h2>Build Duration</h2>
        </div>
        <ChartEmptyState
          className="is-build"
          icon={<BuildEmptyIcon />}
          text="No completed builds yet"
        />
      </section>
    );
  }

  const durationValues = points.map((item) => item.seconds).sort((a, b) => a - b);
  const fastest = durationValues[0];
  const latest = points[points.length - 1]?.seconds ?? null;
  const median = durationValues[Math.floor(durationValues.length / 2)] ?? latest ?? 0;
  const runtimeDeltaPercent =
    median > 0 && latest != null ? Math.round(((latest - median) / median) * 100) : 0;
  const runtimeImproved = runtimeDeltaPercent <= 0;
  const minSeconds = Math.min(...points.map((p) => p.seconds));
  const maxSeconds = Math.max(...points.map((p) => p.seconds));
  const spread = Math.max(1, maxSeconds - minSeconds);
  const center = latest ?? median ?? maxSeconds;
  const halfRange = Math.max(2, Math.ceil(spread * 1.6));
  const domainMin = Math.max(0, Math.floor(center - halfRange));
  const domainMax = Math.ceil(center + halfRange);
  const trendLabel =
    points.length < 2
      ? "Need more runs for trend"
      : `${runtimeImproved ? "Latest faster than median" : "Latest slower than median"} ${Math.abs(runtimeDeltaPercent)}%`;

  return (
    <section className="card graph-card modern">
      <div className="card-head">
        <div className="graph-title">
          <h2>Build Duration</h2>
          <span className="muted">Runtime trend over recent successful runs</span>
        </div>
        <span className="graph-pill">{points.length} runs</span>
      </div>
      <div className="build-chart-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id="buildDurationLineGradient" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#8b5cf6" />
                <stop offset="55%" stopColor="#ec4899" />
                <stop offset="100%" stopColor="#f97316" />
              </linearGradient>
              <linearGradient id="buildDurationAreaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(139, 92, 246, 0.08)" />
                <stop offset="100%" stopColor="rgba(139, 92, 246, 0.01)" />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              stroke={ADMIN_CHART_COLORS.grid}
              strokeDasharray="3 3"
            />
            <XAxis
              dataKey="run"
              tickLine={false}
              axisLine={false}
              minTickGap={22}
              tick={{ fill: ADMIN_CHART_COLORS.axis, fontSize: 11 }}
              tickFormatter={(value) => `#${value}`}
            />
            <YAxis
              width={38}
              tickLine={false}
              axisLine={false}
              tick={{ fill: ADMIN_CHART_COLORS.axis, fontSize: 11 }}
              tickFormatter={(value) => `${value}s`}
              allowDecimals={false}
              domain={[domainMin, domainMax]}
            />
            <Tooltip
              content={<BuildDurationTooltip />}
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
            />
            <ReferenceLine
              y={median}
              stroke="rgba(255,255,255,0.26)"
              strokeDasharray="4 4"
              ifOverflow="extendDomain"
              label={{
                value: `Median ${median}s`,
                fill: "rgba(225,232,244,0.72)",
                fontSize: 11,
                position: "insideTopRight",
              }}
            />
            <Line
              type="monotone"
              dataKey="seconds"
              name="Runtime"
              stroke="url(#buildDurationLineGradient)"
              strokeWidth={2.4}
              dot={{
                r: 3,
                strokeWidth: 1.5,
                fill: "rgba(9,12,18,1)",
                stroke: "rgba(255,255,255,0.75)",
              }}
              activeDot={{
                r: 5,
                strokeWidth: 2,
                fill: "rgba(13,18,28,1)",
                stroke: "rgba(252,253,255,0.95)",
              }}
              isAnimationActive
              animationDuration={420}
            />
            <Area
              type="monotone"
              dataKey="seconds"
              stroke="transparent"
              fill="url(#buildDurationAreaGradient)"
              isAnimationActive
              animationDuration={420}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="graph-meta">
        <span>
          Fastest: <strong>{fastest}s</strong>
          {latest != null ? ` · Latest: ${latest}s` : ""}
          {median ? ` · Median: ${median}s` : ""}
        </span>
        <span className={runtimeImproved ? "trend up" : "trend down"}>{trendLabel}</span>
      </div>
    </section>
  );
}

const numberFmt = new Intl.NumberFormat();

function formatMetricNumber(value) {
  return numberFmt.format(Number(value || 0));
}

function AdminChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="admin-tooltip">
      <strong>{label}</strong>
      <div>
        {payload.map((entry) => (
          <p key={entry.dataKey}>
            <i style={{ background: entry.color }} />
            <span>{entry.name || entry.dataKey}</span>
            <b>{formatMetricNumber(entry.value)}</b>
          </p>
        ))}
      </div>
    </div>
  );
}

function AdminTrendChart({ points }) {
  if (!points.length) {
    return <p className="muted">No activity in the selected range yet.</p>;
  }
  return (
    <div className="admin-chart-wrap">
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={points}>
          <CartesianGrid stroke={ADMIN_CHART_COLORS.grid} strokeDasharray="3 4" />
          <XAxis dataKey="label" tick={{ fill: ADMIN_CHART_COLORS.axis, fontSize: 11 }} />
          <YAxis tick={{ fill: ADMIN_CHART_COLORS.axis, fontSize: 11 }} />
          <Tooltip content={<AdminChartTooltip />} />
          <Legend />
          <Line
            type="monotone"
            dataKey="signups"
            name="Signups"
            stroke={ADMIN_CHART_COLORS.signups}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            type="monotone"
            dataKey="projects"
            name="Projects"
            stroke={ADMIN_CHART_COLORS.projects}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            type="monotone"
            dataKey="deployments"
            name="Deployments"
            stroke={ADMIN_CHART_COLORS.deployments}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function AdminDeploymentQualityChart({ points }) {
  if (!points.length) {
    return <p className="muted">No deployments in the selected range yet.</p>;
  }
  return (
    <div className="admin-chart-wrap">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={points}>
          <CartesianGrid stroke={ADMIN_CHART_COLORS.grid} strokeDasharray="3 4" />
          <XAxis dataKey="label" tick={{ fill: ADMIN_CHART_COLORS.axis, fontSize: 11 }} />
          <YAxis tick={{ fill: ADMIN_CHART_COLORS.axis, fontSize: 11 }} />
          <Tooltip content={<AdminChartTooltip />} />
          <Legend />
          <Bar
            dataKey="succeeded"
            name="Succeeded"
            stackId="deployments"
            fill={ADMIN_CHART_COLORS.succeeded}
            radius={[4, 4, 0, 0]}
          />
          <Bar
            dataKey="failed"
            name="Failed"
            stackId="deployments"
            fill={ADMIN_CHART_COLORS.failed}
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function AdminCanisterChart({ items }) {
  if (!items.length) {
    return <p className="muted">No canister traffic to chart yet.</p>;
  }
  const chartItems = items.slice(0, 10).map((item) => ({
    alias: item.alias,
    websites: Number(item.websites || 0),
  }));
  return (
    <div className="admin-chart-wrap">
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={chartItems}>
          <CartesianGrid stroke={ADMIN_CHART_COLORS.grid} strokeDasharray="3 4" />
          <XAxis dataKey="alias" tick={{ fill: ADMIN_CHART_COLORS.axis, fontSize: 11 }} />
          <YAxis tick={{ fill: ADMIN_CHART_COLORS.axis, fontSize: 11 }} />
          <Tooltip content={<AdminChartTooltip />} />
          <Bar
            dataKey="websites"
            name="Hosted websites"
            fill={ADMIN_CHART_COLORS.signups}
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function AnalyticsBundle(props) {
  const kind = props?.kind || "overview";
  if (kind === "admin-trend") {
    return <AdminTrendChart points={Array.isArray(props.points) ? props.points : []} />;
  }
  if (kind === "admin-quality") {
    return <AdminDeploymentQualityChart points={Array.isArray(props.points) ? props.points : []} />;
  }
  if (kind === "admin-canister") {
    return <AdminCanisterChart items={Array.isArray(props.items) ? props.items : []} />;
  }
  return (
    <>
      <DeploymentActivityCard
        deployments={Array.isArray(props.deployments) ? props.deployments : []}
        project={props.project || null}
      />
      <BuildDurationCard
        deployments={Array.isArray(props.deployments) ? props.deployments : []}
        project={props.project || null}
      />
    </>
  );
}
