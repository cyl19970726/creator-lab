# 产物与审核合同

以下文件名描述研究语义；在本工作台执行时，以已发布的不可变资产类型及精确 `{id,revision,sha256}` 身份为准。JSON字段可扩充，核心含义不能省。宿主保存当前选题版本与未决问题；历史版本不复制为第二正本。

## 最小可追溯对象

**brief.md**：用户目标原文出处、目标读者及前置知识、核心问题、报告用途、已接受口径、可排除项、最低解释深度、交付条件。用户提供的技术段落标为待验证输入，不能因用户说过而成为事实。

**outline.md**：章节目的、依赖的上游概念、要推导的结论、必要图、需要的数据、已知缺口。对部署研究默认原理→硬件×软件与实测→修改机制与实测，经济分析按用户用途选；问题嵌入其因果位置，不以问题列表推翻用户接受的骨架。

**sources.json**：数组；每条至少id、url或本地path、captured_at、作者/机构、原始来源还是转述、independence_group、定位/摘录、采集状态。模型聊天回答是线索；获取原始材料后才成为相应证据。独立发布不是独立测量，同一日志被转发仍是一组。

**claims.json**：数组；id、text、kind（observed/reported/derived/hypothesis/unknown）、source_ids、条件、uncertainties、用途、重要性。关键结论还要calculation_ids或推导定位。登记状态不改变事实可信度；用户报价或截图也标日期和范围。

**benchmarks.json**：数组；id、source_ids、模型/版本、权重、硬件整机拓扑、软件版本、精度、任务模式、输入/输出规模、步数、缓存、并发、计时边界、预热、样本/重复次数、时延统计、成功率、质量验证、缺失字段、comparability_group。按对象选择字段；不适用标明，不补猜。未知字段阻止哪些比较要写出。部署要求区分官方要求、实际测试配置、推导最低需求。

**calculations.json**：数组；id、公式、输入（值/单位/源/时间/不确定性）、单位换算、中间值、输出、假设、边界/敏感性、验证记录。成本明确裸卡/整机、新旧、税费，价格锚不等于成交价。条件概率分母一致，避免质量失败与售出率重复折损。

**questions.json**：数组；id、raised_by、round、location、question、kind、importance、claim_ids、status、answer_location、resolution_reason、reader_recheck、expert_review。status取open/answered_pending_review/verified_answer/known_gap/out_of_scope/reopened。known_gap附gap_id及对核心结论影响；out_of_scope附brief依据。只有verified_answer表示答案已复核；另外两类只是透明处置。作者不能自己签reader_recheck或expert_review。

**gaps.md**：每项id、缺什么、已搜范围/日期、影响哪些结论、最小验证方法、是否阻断本次目标、责任/时间若未知就写未定。宣布新缺口前检查已有证据库，不把已有但未整合的数据当不存在。

**dependencies.json**：数组；产物path、sha256、使用的claim_ids/calculation_ids、派生输入路径。覆盖正文、源图、实际PNG/SVG、HTML/PDF及下游实际引用。改动使哪些审核失效可由该映射确定，不仅靠旧章节号。

## 审核记录

review.json至少包含：stage、reviewer、author、independence（如何独立）、inputs（精确资产身份或 path+sha256）、surfaces_checked、findings（id/severity/location/evidence/impact/repair/recheck_status）、verdict、remaining_limits。工作流审核回执另使用 `target:{id,revision,sha256}`、`decision:pass|revise|insufficient-evidence|human-decision`。核心阻断未修不能pass；有条件通过只能在brief核心仍成立时使用。

作者负责修，独立审核者负责复验和结论。读者提问产生的是理解信号，不是事实证据。结构lint、JSON格式、计算脚本是辅助，不得冒称完成语义审核。文件哈希只验证读过哪一版，不能证明来源真、作者独立或答案正确。

release.md写清当前报告及呈现文件、已验版本、可引用与不可引用结论、未决项、下游限制。交付前核对所有审核输入哈希；变化部分复验。未知项不清零也能诚实交付，但不能偷偷删除核心问题。
