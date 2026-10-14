import type { VideoResearch } from "../../shared/contracts/core";
import { DepthEvidence } from "./DepthReports";

const metricLabels = { likes: "点赞", collections: "收藏", comments: "评论", shares: "分享" };

function displaySourceDate(value: string | null, includeTime = false): string {
  if (value === null) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return includeTime ? date.toLocaleString("zh-CN") : date.toLocaleDateString("zh-CN");
}

export function PostFinalSummary({ data }: { data: VideoResearch }) {
  const summary = data.finalSummary;
  if (!summary) return null;
  return <section className="reader-section post-final-summary" aria-label="单帖综合总结">
    <header><span>END</span><div><p>综合总结</p><h2>整片总结</h2></div></header>
    <p className="post-final-summary__conclusion">{summary.conclusion}</p>
    <div className="post-final-summary__synthesis">
      <section><h3>内容</h3><p>{summary.contentSynthesis}</p></section>
      <section><h3>编导</h3><p>{summary.directingSynthesis}</p></section>
      <section><h3>画面与剪辑</h3><p>{summary.editingSynthesis}</p></section>
    </div>
    <section><h3>可复用的制作经验</h3><ol>{summary.reusableLessons.map((item, index) => <li key={`${index}-${item.lesson}`}>
      <strong>{item.lesson}</strong><p>适用条件：{item.conditions}</p><p>制作动作：{item.action}</p>
      <DepthEvidence data={data} refs={item.evidenceRefs}/>
    </li>)}</ol></section>
    <section><h3>这条作品的实际表现</h3>
      <p className="post-final-summary__source">抓取时间：{displaySourceDate(summary.performance.observedAt, true)} · 发布时间：{displaySourceDate(summary.performance.publishedLabel)}</p>
      <dl className="post-final-summary__metrics">{summary.performance.observedMetrics.map((item) => <div key={item.metric}>
        <dt>{metricLabels[item.metric]}</dt><dd>{item.value === null ? "未取得" : item.value.toLocaleString("zh-CN")}</dd>
      </div>)}</dl>
      <p>{summary.performance.interpretation}</p>
      {summary.performance.comparison && <p>{summary.performance.comparison}</p>}
      <ul>{summary.performance.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <DepthEvidence data={data} refs={summary.performance.evidenceRefs}/>
    </section>
    <section><h3>结论边界</h3><ul>{summary.limits.map((item, index) => <li key={index}>{item}</li>)}</ul></section>
  </section>;
}
