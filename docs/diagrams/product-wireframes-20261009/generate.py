#!/usr/bin/env python3
"""Generate the twelve static product wireframes; no external dependencies."""
from html import escape
from pathlib import Path

OUT = Path(__file__).parent
INK = '#232323'
MUTED = '#666'
LINE = '#b6b6b6'
FAINT = '#e5e5e5'
PAPER = '#fff'


class Page:
    def __init__(self, title, active, subtitle='', height=760, nav=True, nav_state='versioned'):
        self.h = height
        self.s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 {height}" width="1280" height="{height}">',
                  f'<rect width="1280" height="{height}" fill="{PAPER}"/>',
                  '<style>text{font-family:Arial,"PingFang SC","Noto Sans CJK SC",sans-serif;fill:#232323} .muted{fill:#666}</style>']
        if nav:
            self.box(0, 0, 215, height, fill='#fafafa', stroke=LINE)
            self.t(20, 30, 'SPACE / 内容创作', 18, bold=True)
            self.t(20, 57, '目的：形成可交付内容', 13, muted=True)
            if nav_state == 'empty':
                self.nav_empty()
            else:
                self.nav(active)
            self.box(215, 0, 1065, 72, stroke=LINE)
            self.t(239, 31, title, 21, bold=True)
            self.t(239, 57, subtitle or 'Space 目标 · 工作流 CONTENT · 准确对象与范围见各页', 13, muted=True)
            self.t(1258, 56, '合成线框示意 · 非实测', 11, muted=True, anchor='end')
            self.line(940, 72, 940, height)
        else:
            self.box(0, 0, 1280, 72, stroke=LINE)
            self.t(25, 32, title, 22, bold=True)
            self.t(25, 59, subtitle, 13, muted=True)

    def nav(self, active):
        rows = [
            ('业务目标与问题', 100, 0), ('▾ 工作流 · CONTENT', 145, 0),
            ('版本总览', 181, 1), ('版本遗传图谱', 215, 1),
            ('▾ 当前查看 v2  [切换]', 253, 1),
            ('设计目标与改动', 289, 2), ('方法与产出图', 323, 2),
            ('案例与资产', 357, 2), ('评价与分析', 391, 2),
            ('调优与后续版本', 425, 2), ('服务与复盘', 469, 1),
            ('全部业务案例', 513, 0), ('资产库', 551, 0),
        ]
        for label, y, indent in rows:
            if label == active:
                self.box(8, y-20, 198, 29, fill='#ececec', stroke='none')
            self.t(19+13*indent, y, label, 14, bold=(label == active))
        self.line(16, 592, 199, 592, FAINT)
        self.t(20, 620, '查看 v2 ≠ 采用 v2', 12, muted=True)
        self.t(20, 640, '最新发布 / 采用 / 可执行分列', 11, muted=True)

    def nav_empty(self):
        self.box(8,80,198,29,fill='#ececec',stroke='none')
        self.t(19,100,'业务目标与问题',14,bold=True)
        self.t(19,145,'工作流：尚未建立',14,muted=True)
        self.t(19,188,'首版设计入口',14)
        self.t(20,620,'无版本 / 无 Case / 无采用',12,muted=True)

    def box(self, x, y, w, h, fill='none', stroke=LINE, r=0, sw=1):
        self.s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')

    def line(self, x1, y1, x2, y2, stroke=LINE, sw=1, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ''
        self.s.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def t(self, x, y, value, size=15, bold=False, muted=False, anchor=None):
        attrs = f' font-size="{size}"'
        if bold: attrs += ' font-weight="600"'
        if muted: attrs += ' class="muted"'
        if anchor: attrs += f' text-anchor="{anchor}"'
        self.s.append(f'<text x="{x}" y="{y}"{attrs}>{escape(value)}</text>')

    def lines(self, x, y, rows, size=14, step=24, muted=False):
        for i, row in enumerate(rows): self.t(x, y+i*step, row, size, muted=muted)

    def node(self, x, y, w, h, number, title, sub='', selected=False):
        self.box(x, y, w, h, fill='#f0f0f0' if selected else '#fff', stroke=INK if selected else LINE, r=4, sw=1.5 if selected else 1)
        self.t(x+12, y+23, f'{number}  {title}', 15, bold=True)
        if sub: self.t(x+12, y+45, sub, 12, muted=True)

    def arrow(self, x1, y1, x2, y2, label=None, dash=None):
        self.line(x1,y1,x2,y2,INK,1.3,dash)
        self.s.append(f'<path d="M {x2-7} {y2-4} L {x2} {y2} L {x2-7} {y2+4}" fill="none" stroke="{INK}" stroke-width="1.3"/>')
        if label: self.t((x1+x2)/2,(y1+y2)/2-7,label,11,muted=True,anchor='middle')

    def canvas(self, caption, scope='示意关系 · 选中对象 → 右侧详情'):
        self.t(239, 105, caption, 17, bold=True)
        self.t(239, 126, scope, 12, muted=True)
        self.line(239, 139, 916, 139, FAINT)

    def detail(self, heading, identity, sections):
        self.t(961, 107, '选中对象 · 详情', 13, muted=True)
        self.t(961, 140, heading, 19, bold=True)
        self.t(961, 165, identity, 12, muted=True)
        self.line(960, 181, 1258, 181, FAINT)
        y = 211
        for label, rows in sections:
            self.t(961, y, label, 14, bold=True)
            y += 24
            self.lines(961, y, rows, 13, 21)
            y += 21*len(rows)+19
        return y

    def save(self, name):
        self.s.append('</svg>')
        (OUT/name).write_text('\n'.join(self.s)+'\n', encoding='utf-8')


def shell():
    p=Page('工作台共用外壳', '▾ 当前查看 v2  [切换]', '导航为长期任务；图面与右侧详情可调宽，长文可扩大阅读')
    p.canvas('中心：沿用 Archify 画布', '方法、Case、版本谱系分别使用准确图语义')
    p.node(270,215,176,72,'1','当前对象','版本 v2 / Case / 资产')
    p.node(535,215,230,72,'2','图中关系','控制 / 生产 / 评价')
    p.arrow(446,251,535,251)
    p.box(258,338,643,260,fill='#fafafa',stroke=LINE)
    p.t(280,370,'沿用 Archify 查看器基础',18,bold=True)
    p.lines(280,405,['已有：方法 / 单 run 图；搜索、聚焦、导出与对象详情','待扩展：完整 Case 资产关系、跨版本谱系语义','展开正文后保留图位置；此图表达目标布局'],15,33)
    p.detail('② 图中选中的对象','范围：准确版本、Case、run 与资产',[
        ('就近阅读',['标题、状态与准确身份','正文／配置、来源、相关评价']),
        ('长文',['扩大阅读或分屏；关闭返回原图位置']),
        ('状态边界',['查看版本不改变采用','选中资产不改变接受或交付']),
    ])
    p.save('00-shell.svg')


def goal():
    p=Page('业务目标与问题', '业务目标与问题', '初建 Space · 尚无 workflow / Case', nav_state='empty')
    p.canvas('Space 目的 → 形成首版方法的依据','尚无方法时显示清楚的起点，不伪造版本或运行状态')
    p.node(260,204,270,83,'1','业务目的','为具体受众形成可交付内容',True)
    p.node(600,204,270,83,'2','受众与用途','读者 / 使用场景 / 交付方式')
    p.node(260,348,270,83,'3','成功标准','内容质量、证据与可用性')
    p.node(600,348,270,83,'4','未知与约束','材料不足、评价口径未定')
    p.arrow(530,244,600,244)
    p.arrow(530,390,600,390)
    p.box(260,512,610,75,fill='#f8f8f8')
    p.t(281,542,'5  首版入口：目的 + 材料 + 标准 → 具名方法草案',15,bold=True)
    p.t(281,567,'草案可保存并关联首委托；显式启动前再检查执行条件',12,muted=True)
    p.detail('① Space 目的','当前状态：无 workflow；无采用版本',[
        ('具体目标',['让目标受众获得可信、可交付的内容。']),
        ('设计输入',['用途、受众、已有材料、成功标准。']),
        ('未知',['评分机制尚未定义；样例覆盖待补。']),
        ('后续',['保存业务草案；首委托携带准确草案快照。']),
    ])
    p.save('01-goal.svg')


def versions():
    p=Page('版本总览', '版本总览', '比较列表 · 当前查看 v2；采用状态独立于查看与最新发布')
    p.canvas('准确版本比较','版本名、动机、前驱、可执行性、Case / run / 评价覆盖')
    p.box(247,171,672,45,fill='#f5f5f5')
    p.t(262,199,'版本 / 设计目的',14,bold=True)
    p.t(475,199,'前驱与改动',14,bold=True)
    p.t(700,199,'状态 / 覆盖',14,bold=True)
    rows=[(225,'① v1 · 首版','业务基线','无前驱','既有 · 不可执行','Case 2 / Run 3'),
          (332,'② v2 · 改进稿','改写关键审阅','来自 v1','最新发布 · 未采用','Case 1 / Run 1'),
          (439,'③ 候选分支','仅有记录时显示','按真实前驱','示意位：此处非事实','—')]
    for y,num,title,prev,state,cover in rows:
        p.box(247,y,672,93,fill='#eee' if num.startswith('②') else '#fff',stroke=INK if num.startswith('②') else LINE)
        p.t(261,y+27,num,16,bold=True)
        p.t(261,y+54,title,12,muted=True)
        p.t(476,y+28,prev,13)
        p.t(700,y+27,state,12)
        p.t(700,y+52,cover,12,muted=True)
    p.t(254,577,'查看 = 保留准确版本上下文   ·   采用 = 改变指定业务范围   ·   执行 = 显式启动一次委托',13)
    p.detail('② v2 · 改进稿','正在查看 v2 · 未采用 · 最新发布',[
        ('版本身份',['准确 ID 按需展开；不可只靠时间戳。']),
        ('改动',['针对 v1 审阅问题；依据见设计目标。']),
        ('覆盖',['Case A / R3：完成未评；Case 1，Run 1。']),
        ('可用动作',['查看方法与证据；采用需指定范围。','执行需检查部署与本次材料。']),
    ])
    p.save('02-versions.svg')


def motive():
    p=Page('v2 · 设计目标与改动','设计目标与改动','准确版本 v2 · 前驱 v1 · 目标与证据分开')
    p.canvas('为什么形成 v2','问题 → 依据 → 改动 → 验证；点击编号看原证据')
    coords=[(252,224,'1','待修问题','v1 审阅未覆盖来源'),(582,224,'2','原依据','Case A / R2·v1 评价'),
            (252,392,'3','选定改动','新增来源核查交接'),(582,392,'4','验证边界','计划 P / 实际覆盖')]
    for x,y,n,t,sub in coords:p.node(x,y,286,84,n,t,sub,n=='2')
    p.arrow(538,266,582,266)
    p.arrow(538,434,582,434)
    p.arrow(394,308,394,392)
    p.arrow(725,308,725,392)
    p.box(252,544,616,61,fill='#fafafa')
    p.t(270,570,'设计目标：提高来源可追溯性；是否改善以验证证据判断',14,bold=True)
    p.t(270,592,'此处是示意任务，实际版本结论须回到真实记录',11,muted=True)
    p.detail('② 原依据 · R2 评价','来自 v1 / Case A / 计划 P 外',[
        ('原始观察',['审阅指出来源难追；结论附原文。']),
        ('证据定位',['Case、run、稿件、判者与标准版本。']),
        ('解释边界',['一个意见不能证明所有 Case 均失败。']),
        ('回到图',['选中问题或改动，保留 v2 上下文。']),
    ])
    p.save('03-motive.svg')


def method():
    p=Page('v2 · 方法与产出图','方法与产出图','定义模式 · 预期资产类型，不是已经生成的实物')
    p.canvas('沿用 Archify 画布 · 方法图布局','流程节选：实际画布承载完整分支、循环与停止；虚线=资产关系')
    p.node(246,205,137,68,'1','输入','要求 + 材料')
    p.node(430,205,170,68,'2','研究 Agent','需证据材料',True)
    p.node(657,205,199,68,'3','作者 Agent','消费研究报告')
    p.arrow(383,239,430,239,'控制')
    p.arrow(600,239,657,239,'控制')
    p.node(430,328,170,65,'A','研究报告','预期资产类型')
    p.node(657,328,199,65,'B','稿件','预期资产类型')
    p.line(515,273,515,328,INK,1.2,'5 4')
    p.line(756,273,756,328,INK,1.2,'5 4')
    p.s.append(f'<path d="M 600 361 H 625 V 300 H 700 V 273" fill="none" stroke="{INK}" stroke-width="1.2" stroke-dasharray="5 4"/>')
    p.s.append(f'<path d="M 696 280 L 700 273 L 704 280" fill="none" stroke="{INK}" stroke-width="1.2"/>')
    p.node(431,452,191,68,'4','冷读 / 核查','意见 → 审阅')
    p.node(657,452,199,68,'5','主编判断','通过 / 返工 / 停止')
    p.s.append(f'<path d="M 856 239 H 886 V 423 H 526 V 452" fill="none" stroke="{INK}" stroke-width="1.3"/>')
    p.s.append(f'<path d="M 522 445 L 526 452 L 530 445" fill="none" stroke="{INK}" stroke-width="1.3"/>')
    p.arrow(622,486,657,486,'控制')
    p.t(455,554,'B 稿件供冷读/核查；意见供主编；返工 → 作者',13)
    p.t(455,581,'缺材料 → 等待/停止；点 A/B 读 schema、角色、消费者',12,muted=True)
    p.detail('② 研究 Agent','v2 方法定义 · 不是本次运行',[
        ('职责与输入',['按要求整理来源；必需输入见合同。']),
        ('方法配置',['Prompt / model / tools / 可选 skill','完整长文按需展开。']),
        ('自主边界',['材料不足时等待或提出缺口；','不得擅自扩大来源与执行权限。']),
        ('预期输出',['A 研究报告：schema、用途与消费方。']),
    ])
    p.save('04-method.svg')


def case():
    p=Page('Case A · 案例与资产','案例与资产','跨版本范围：v1 / v2；每个 run 与资产保留准确方法身份')
    p.canvas('沿用 Archify 画布 · Case 实际资产关系','关系节选；资产与运行记录分型，完整资产由列表/数量继续到达')
    p.box(246,158,668,42,fill='#fafafa')
    p.t(258,185,'A / 跨版：R1·v1失败   R2·v1完成有评   R3·v2完成未评',13,bold=True)
    p.node(257,245,150,68,'1','Abrief','R1 / v1 初始输入')
    p.node(475,245,172,68,'2','补充材料','R2 / v1 后来新增')
    p.node(728,245,159,68,'3','R1 运行记录','失败 / 无主稿')
    p.s.append(f'<path d="M 407 279 V 218 H 807 V 245" fill="none" stroke="{INK}" stroke-width="1.3"/>')
    p.s.append(f'<path d="M 803 238 L 807 245 L 811 238" fill="none" stroke="{INK}" stroke-width="1.3"/>')
    p.t(565,212,'R1 输入交付',11,muted=True)
    p.node(475,378,172,68,'4','稿件 v1.2','R2 / v1 完成',True)
    p.node(728,378,159,68,'5','成果 v2.1','R3 / v2 完成')
    p.line(561,313,561,378,INK,1.2,'5 4')
    p.t(647,359,'后续输入',11,muted=True)
    p.box(258,500,629,87,fill='#fafafa')
    p.lines(275,528,['R1 仅 Abrief 等早期输入且失败；R2 补材完成有评，但在计划 P 外。','R3 完成未评；跨版本范围不把 R2 的评价归给 v2。'],13,28)
    p.detail('④ 稿件 v1.2 · 正文','Case A / v1 / R2 / 准确资产版本',[
        ('内容',['稿件正文阅读区；长文可扩大阅读。']),
        ('来源',['Abrief ① 与 R2 新增材料 ② 分开。']),
        ('评价',['本 run 有评价；R2 不属于计划 P。']),
        ('关系',['生产方法 v1；点边看交付与使用记录。']),
    ])
    p.save('05-case.svg')


def evaluation():
    p=Page('v2 · 评价与分析','评价与分析','正在查看 v2；计划 P 含 v1 与 v2 对照，评分机制尚未定义')
    p.canvas('版本证据与验证计划 P 对账','计划四项跨 v1 / v2；v2 自身为 R3 完成未评、B/v2 未开始')
    p.box(248,166,650,78,fill='#fafafa')
    p.t(264,195,'v2 结论：尚不能判断是否优于 v1',15,bold=True)
    p.t(264,222,'A/v2 R3 完成未评；B/v2 未开始，缺少比较证据',12,muted=True)
    p.box(248,278,650,42,fill='#f5f5f5')
    p.t(261,305,'计划 P 项目',14,bold=True)
    p.t(565,305,'实际证据',14,bold=True)
    p.t(773,305,'状态',14,bold=True)
    rows=[(320,'① A / v1','R1 · 已启动','失败'),(383,'② A / v2','R3 · 已完成','未评'),(446,'③ B / v1','R4 · 已完成','有评'),(509,'④ B / v2','无 run','未开始')]
    for y,a,b,c in rows:
        p.box(248,y,650,63,fill='#fff',stroke=LINE)
        p.t(260,y+38,a,14)
        p.t(565,y+38,b,13)
        p.t(773,y+38,c,13,bold=True)
    p.t(255,604,'计划外：A / v1 / R2 完成有评；不可静默替代计划中的 R1。',12,muted=True)
    p.detail('② A / v2 · R3 未评','计划 P / v2 / Case A / Run R3',[
        ('准确状态',['运行记录存在，独立评价尚未完成。']),
        ('可读证据',['输入、已产资产、执行条件与过程。']),
        ('分析影响',['不能当作零分，也不能当作通过。']),
        ('综合边界',['B/v2 未开始；R2 属 v1 且在计划外。']),
    ])
    p.save('06-evaluation.svg')


def tuning():
    p=Page('v2 · 调优与后续版本','调优与后续版本','当前 v2 的后续判断；尚无已记录的后继候选')
    p.canvas('沿用 Archify 画布 · 后续工作','实线=已发现缺口；虚线=待证假设与未编号提议')
    p.node(255,203,154,67,'1','验证缺口','R3未评 / B未开始')
    p.node(479,186,183,67,'2a','原因假设 A','评价覆盖不足',True)
    p.node(479,274,183,67,'2b','原因假设 B','输入差异')
    p.arrow(409,235,479,220,dash='5 4')
    p.arrow(409,235,479,308,dash='5 4')
    p.node(737,203,157,67,'3','改动提议','尚未形成后继版')
    p.arrow(662,220,737,235,dash='5 4')
    p.node(255,417,154,67,'4','验证要求','A/B 可比条件')
    p.node(479,417,183,67,'5','近期动作','先补 v2 评价')
    p.node(737,417,157,67,'6','当前决定','暂不改 / 待证')
    p.arrow(409,450,479,450)
    p.arrow(662,450,737,450)
    p.line(815,270,332,417,INK,1,'5 4')
    p.box(254,547,640,73,fill='#fafafa')
    p.t(270,574,'其他分支：不改 / 补证据或校准判者 / dogfood issue',14,bold=True)
    p.t(270,599,'项目 issue 关闭后仍需业务复验；提议不等于已发布版本',12,muted=True)
    p.detail('②a 待证假设 A','关联缺口 ①；不是已证实原因',[
        ('现有证据',['A/v2 R3 完成未评；B/v2 尚未开始。']),
        ('竞争解释',['输入、判者或标准差异也可能影响比较。']),
        ('下一步',['先补 v2 评价，核对计划 P 的可比条件。']),
        ('状态',['改动只是一项未编号提议，尚无后继版。']),
    ])
    p.save('07-tuning.svg')


def lineage():
    p=Page('版本遗传图谱','版本遗传图谱','真实关系：v1 → v2；分支仅按实际记录显示')
    p.canvas('沿用 Archify 画布 · 版本谱系','节点=准确方法版本；边=有依据的变更关系')
    p.node(295,246,215,92,'1','v1 · 首版','既有 / 目前不可执行')
    p.node(656,246,215,92,'2','v2 · 改进稿','最新发布 / 未采用',True)
    p.arrow(510,292,656,292,'问题 → 改动 → 验证')
    p.box(310,439,545,91,fill='#fafafa',stroke=LINE)
    p.t(329,471,'可能有分支：按实际前驱记录显示',15,bold=True)
    p.t(329,497,'此处不绘制虚构的 v3 或无依据的时间顺序连线',12,muted=True)
    p.t(290,594,'点版本 → 方法 summary；点变更边 → 原问题、改动、验证；最新 ≠ 采用',13)
    p.detail('② v2 · 方法摘要','准确版本 / 前驱 v1 / 最新发布',[
        ('目标',['解决 v1 来源追溯问题。']),
        ('方法概要',['关键节点、预期产物、返工与停止。']),
        ('采用',['当前采用另有范围；本图不推断采用。']),
        ('点边时',['改读原问题、改动节点、验证证据。']),
    ])
    p.save('08-lineage.svg')


def service():
    p=Page('服务与复盘','服务与复盘','按采用范围和服务窗口观察业务；不自动改派既有委托')
    p.canvas('采用状态与真实服务覆盖','业务范围、窗口、执行条件、评价覆盖和人工负担')
    p.box(252,178,636,116,fill='#fafafa')
    p.t(270,208,'① 采用范围：内容创作主方法 / 指定业务入口',15,bold=True)
    p.t(270,237,'服务窗口：最近 7 天（台北时间）   ·   证据截至：示意',13)
    p.t(270,265,'当前采用指针与最新发布、可执行部署分别核对',13)
    p.box(252,329,305,115)
    p.t(270,362,'② v1 · 既有采用记录',15,bold=True)
    p.t(270,391,'当前不可执行；历史仍可读',13)
    p.box(583,329,305,115)
    p.t(601,362,'③ v2 · 候选可执行',15,bold=True)
    p.t(601,391,'尚未采用；不能静默接管',13)
    p.box(252,480,636,125,fill='#fafafa')
    p.t(270,510,'④ 待处理列表 / 业务覆盖',15,bold=True)
    p.lines(270,540,['失败与无产物 · 未评价 · 人工介入 · 重复问题','点状态下钻准确 Case / run；显示纳入与排除数量'],13,27)
    p.detail('② 采用范围与阻塞','主方法 slot / 指定业务范围',[
        ('当前情况',['v1 有既有采用记录，但部署不可执行。']),
        ('下一步决定',['核对恢复条件、候选适用性与范围。']),
        ('派发边界',['新委托显式等待或选择试跑；','既有委托不会自动改派到 v2。']),
    ])
    p.save('09-service.svg')


def library():
    p=Page('全部业务案例 / 资产库','全部业务案例','两个并列入口状态 · 同一 Space，跨版本检索',height=850)
    p.canvas('入口 A · 全部业务案例','日常从真实题目进入；范围不随正在查看的 v2 自动过滤')
    p.box(249,159,651,50,fill='#f5f5f5')
    p.t(266,190,'题目 / 要求',14,bold=True)
    p.t(528,190,'成果 / 状态',14,bold=True)
    p.t(771,190,'关联方法',14,bold=True)
    p.box(249,209,651,76)
    p.t(266,238,'① Case A · 选题写稿',14,bold=True)
    p.t(528,238,'R1失败；R2/R3完成',12)
    p.t(771,238,'v1、v2',12)
    p.t(266,264,'进入后查看准确 Case 图与全部 run',12,muted=True)
    p.box(249,285,651,76)
    p.t(266,314,'② Case B · 验证题目',14,bold=True)
    p.t(528,314,'R4/v1完成有评；v2未开始',12)
    p.t(771,314,'v1；v2计划',12)
    p.t(249,405,'入口 B · 资产库',17,bold=True)
    p.t(249,426,'按类型、案例、阶段、时间或评价状态找准确资产',12,muted=True)
    p.box(249,447,651,50,fill='#f5f5f5')
    p.t(266,478,'资产 / 类型',14,bold=True)
    p.t(528,478,'来源与关系',14,bold=True)
    p.t(771,478,'生产版本',14,bold=True)
    p.box(249,497,651,78)
    p.t(266,529,'③ 稿件 v1.2 · 正文',14,bold=True)
    p.t(528,529,'Case A / R2 / 作者',12)
    p.t(771,529,'v1',12)
    p.t(266,555,'可读内容、准确版本、引用与评价',12,muted=True)
    p.box(249,575,651,78)
    p.t(266,607,'④ Abrief · 原输入',14,bold=True)
    p.t(528,607,'Case A / R1 / 初始材料',12)
    p.t(771,607,'外部输入',12)
    p.detail('③ 稿件 v1.2','从资产库选中 / 跨 Case 可追溯',[
        ('正文',['按业务类型阅读，保留准确资产版本。']),
        ('关系',['生产于 Case A / R2 / 方法 v1；','此 run 完成有评，但在计划 P 外。']),
        ('复用',['引用到新委托保留原来源与新用途。']),
        ('范围',['不被左侧当前查看 v2 默默筛掉。']),
    ])
    p.save('10-library.svg')


def actions():
    p=Page('两个入口 · 首版设计 / 新委托','业务目标与问题','覆盖层与底层图共享选择状态；此页上下两种状态')
    p.canvas('状态 A · 从零形成首版','底层：Space 目的及标准；覆盖层输入结果是业务草案')
    p.box(249,164,647,198,fill='#fafafa')
    p.t(266,191,'保留底层图：目的 ① → 受众 ② → 标准 ③',13,muted=True)
    p.box(285,211,574,117,fill='#fff',stroke=INK,sw=1.5)
    p.t(303,238,'首版设计阅读层',16,bold=True)
    p.t(303,264,'目的 / 材料 / 成功标准 / 未知 → 具名业务草案',13)
    p.t(303,289,'第一委托携带准确草案 snapshot；草案 ≠ 可执行版本',12,muted=True)
    p.t(249,415,'状态 B · 新委托',17,bold=True)
    p.t(249,436,'底层：Case 关系或服务状态；填写要求时不丢原选择',12,muted=True)
    p.box(249,452,647,205,fill='#fafafa')
    p.t(266,479,'保留底层图：Case 输入 ① → 已有资产 ② → 方法状态 ③',13,muted=True)
    p.box(285,499,574,125,fill='#fff',stroke=INK,sw=1.5)
    p.t(303,526,'新委托阅读层',16,bold=True)
    p.t(303,553,'要求 / 材料 / 本次方法 / 启动前检查',13)
    p.t(303,579,'采用版 v1 不可执行 → 等待；v2 可候选试跑',13)
    p.t(303,604,'候选试跑需明确选择，不自动采用或改派既有 Case',12,muted=True)
    p.detail('③ 方法状态 / 下一步','新委托范围 · 准确方法与部署',[
        ('采用版',['v1 有采用记录，但当前不可执行。']),
        ('候选',['v2 可供显式试跑；未采用。']),
        ('输入冻结',['启动前核对要求与材料；','第一委托保留草案 snapshot。']),
        ('返回',['关闭阅读层恢复原图和所选 Case。']),
    ])
    p.save('11-actions.svg')


if __name__ == '__main__':
    for fn in [shell,goal,versions,motive,method,case,evaluation,tuning,lineage,service,library,actions]: fn()
    print('Generated 12 SVG files in', OUT)
