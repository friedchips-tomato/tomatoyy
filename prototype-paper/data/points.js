// 长堤风貌街像素导览 · 内容数据（文字由 Claude 编写，代码只读取不改写）
// 坐标说明：hotspot 为在 assets/map.jpg 上的百分比矩形 {x, y, w, h}，左上角为原点。
// 热区已按 assets/map.jpg（GPT 生成，1024×1536）标定。当前点位顺序与方位为示意，门牌与经纬度均未核实；拿到需求方点位数据后替换。
window.CD_DATA = {
  meta: {
    title: "长堤风貌街",
    subtitle: "像素导览 · 演示版",
    disclaimer: "演示版：地图为示意，点位位置与建筑外观待现场核实；停车与讲解员为示范数据。",
    overview:
      "长堤是江门城区的发源地，也是江门保存最完整的近代城市街区之一。街区东起蓬江大桥，西至江门铁桥，沿江约 1.5 公里。这里自明代形成墟集，1904 年江门辟为对外通商口岸后商号林立，沿江留下数百间中西合璧的骑楼。",
    overviewSources: [
      "江门市住建局负责人表述，见中国新闻网 2025-10-22 报道",
      "凤凰网《江门墟兴 老城脉续——江门历史文化街区活化的观察与思考》",
      "携程景点页「长堤风貌街」"
    ]
  },

  points: [
    {
      id: "CD-R01",
      name: "蓬江大桥",
      name_en: "Pengjiang Bridge",
      category: "地标",
      key: false,
      hotspot: { x: 60, y: 3, w: 38, h: 7 },
      oneLine: "长堤历史文化街区的东端起点。",
      intro: "按公开资料，长堤历史文化街区东起蓬江大桥、西至江门铁桥，沿江约 1.5 公里。从这里往下，就是整条长堤。",
      guide: {
        zh: "这里是长堤的东端。从蓬江大桥一路向西，到江门铁桥为止，沿江大约一点五公里，就是长堤历史文化街区。往下滑，我们从这头开始走。",
        yue: "呢度系长堤嘅东头。由蓬江大桥一路向西行，行到江门铁桥为止，沿住条江大约一点五公里，就系长堤历史文化街区。向下碌，我哋由呢头开始行。",
        en: "This is the east end of Changdi. From Pengjiang Bridge west to the Jiangmen Iron Bridge, about one and a half kilometres along the river, lies the Changdi historic district. Scroll down and let's start walking from here."
      },
      sources: ["携程景点页「长堤风貌街」"]
    },
    {
      id: "CD-V01",
      name: "启明里",
      name_en: "Qimingli Village",
      category: "侨村",
      key: true,
      card: "assets/card-qimingli.jpg",
      cardName: "青砖巷口",
      hotspot: { x: 2, y: 9, w: 22, h: 12 },
      oneLine: "长堤东侧的华侨村落。",
      intro: "启明里位于长堤历史风貌区东侧，是江门中心城区的华侨村落之一，近年开展过片区微更新。这里住过哪些侨眷、何时建成，史料仍在整理，核实后补充。",
      guide: {
        zh: "你现在来到启明里。它在长堤历史风貌区的东侧，是江门中心城区的华侨村落之一。走进巷子，可以留意侨房的门楼和窗户。这里住过哪些侨眷、建于哪一年，我们还在整理史料，核实后会补充进讲解。",
        yue: "你而家嚟到启明里。佢喺长堤历史风貌区嘅东边，系江门市区入面嘅华侨村落之一。行入条巷，可以留意下侨屋嘅门楼同埋啲窗。呢度住过边啲侨眷、几时起嘅，我哋仲整理紧史料，核实咗之后会补返入讲解度。",
        en: "You are now at Qimingli, on the east side of the Changdi historic district. It is one of the overseas-Chinese villages in central Jiangmen. As you walk into the lane, look at the gateways and windows of the old houses. We are still checking the records on who lived here and when it was built, and will add them once confirmed."
      },
      sources: ["中国新闻网 2025-10-22 报道", "期刊论文《长堤历史文化街区启明里片区微更新实践》（题名据检索结果）"]
    },
    {
      id: "CD-A02",
      name: "江门海关旧址（示意）",
      name_en: "Former Jiangmen Customs (approx.)",
      category: "历史建筑",
      key: true,
      card: "assets/card-haiguan.jpg",
      cardName: "开埠一九零四",
      hotspot: { x: 24, y: 12, w: 27, h: 18 },
      oneLine: "与 1904 年江门开埠相关的点位。位置待核实。",
      intro: "据公开报道，江门于 1904 年辟为对外通商口岸，此后长堤一带商号林立。海关旧址的确切位置、建筑外观和保护等级本次尚未核实，地图上的这栋建筑只是示意。",
      guide: {
        zh: "一九零四年，江门辟为对外通商口岸，长堤沿江一带随之商号林立。地图上这栋楼标的是海关旧址的位置示意，确切地址和建筑样貌还在核实。等史料确认后，这一站会补上完整讲解。",
        yue: "一九零四年，江门开埠做对外通商口岸，长堤沿江一带跟住开满商号。地图上面呢栋楼标嘅系海关旧址嘅大概位置，准确地址同建筑样貌仲核实紧。等史料确认咗，呢一站会补返完整讲解。",
        en: "In 1904 Jiangmen opened as a treaty port, and shops soon lined the Changdi riverfront. This building marks the approximate site of the former customs house; its exact address and appearance are still being verified. A full narration will follow once the records are confirmed."
      },
      sources: ["凤凰网《江门墟兴 老城脉续》"]
    },
    {
      id: "CD-A01",
      name: "江门市博物馆长堤分馆",
      name_en: "Jiangmen Museum · Changdi Branch",
      category: "历史建筑",
      key: true,
      card: "assets/card-museum.jpg",
      cardName: "双联骑楼",
      hotspot: { x: 34, y: 39, w: 21, h: 17 },
      oneLine: "开在晚清民初双联骑楼里的博物馆分馆。",
      intro: "分馆设在一座晚清民初的双联骑楼内，曾推出「烟火长堤」主题展，馆内还设有咖啡和非遗体验空间。开放时间以馆方公布为准。",
      guide: {
        zh: "眼前是两栋并肩相连的骑楼，叫双联骑楼，建于晚清民初。现在它是江门市博物馆的长堤分馆，办过「烟火长堤」主题展，里面还有咖啡和非遗体验空间。走累了，可以进去坐一坐。",
        yue: "你面前系两栋孖住起嘅骑楼，叫双联骑楼，系晚清民初起嘅。而家佢系江门市博物馆嘅长堤分馆，搞过「烟火长堤」主题展，入面仲有咖啡同非遗体验空间。行攰咗，可以入去坐下。",
        en: "In front of you are two arcade buildings joined side by side, a twin qilou from the late Qing and early Republican era. It now houses the Changdi branch of the Jiangmen Museum, which has hosted the 'Smoke and Fire of Changdi' exhibition and has a café and an intangible-heritage workshop inside. If you're tired, step in and rest."
      },
      sources: ["携程景点页「长堤风貌街」", "新快报 2024-08-28 报道"]
    },
    {
      id: "CD-A03",
      name: "水埠头石阶",
      name_en: "Shuibutou River Steps",
      category: "历史遗存",
      key: true,
      card: "assets/card-shuibutou.jpg",
      cardName: "石阶入江",
      hotspot: { x: 55, y: 53, w: 24, h: 12 },
      oneLine: "一级级伸入江水的石阶码头。",
      intro: "水埠头是沿江的石阶码头，石阶从岸边一级级伸进江水，也是影视作品的取景地。游记中记为 33 级，待现场核实。",
      guide: {
        zh: "顺着石阶往下看，台阶一级一级伸进江水里，这就是水埠头。过去人们在这里上下船、取水洗衣。它也是好几部影视作品的取景地。有游记说这里一共三十三级，你可以自己数一数。",
        yue: "顺住啲石级向下望，一级一级伸落江水度，呢度就系水埠头。旧时啲人喺度上落船、担水洗衫。佢都系几套影视作品嘅取景地。有游记话呢度一共三十三级，你可以自己数下。",
        en: "Follow the stone steps down as they reach into the river: this is Shuibutou, the old water landing. It has appeared in several film and TV productions. Travel notes say there are 33 steps. Why not count them yourself?"
      },
      sources: ["携程游记", "澎湃新闻报道"]
    },
    {
      id: "CD-S01",
      name: "堤东路骑楼",
      name_en: "Didong Road Arcades",
      category: "骑楼街",
      key: true,
      card: "assets/card-qilou.jpg",
      cardName: "罗马拱券",
      hotspot: { x: 25, y: 61, w: 26, h: 19 },
      oneLine: "长堤骑楼最集中的路段。",
      intro: "堤东路是长堤骑楼的主要路段。沿街骑楼中西合璧，可以看到罗马式拱券、彩色玻璃的满洲窗，以及女儿墙上的浮雕山花。",
      guide: {
        zh: "抬头看看这排骑楼。底层连续的拱券是罗马式的，楼上彩色玻璃的窗户叫满洲窗，屋顶女儿墙中间那块装饰是浮雕山花。西式拱券和岭南的满洲窗在同一面墙上，这就是长堤骑楼的中西合璧。",
        yue: "抬起头睇下呢排骑楼。地下一路落嘅拱券系罗马式，楼上嗰啲彩色玻璃窗叫满洲窗，天面女儿墙中间嗰块装饰系浮雕山花。西式拱券同岭南满洲窗喺同一幅墙度，呢样就系长堤骑楼嘅中西合璧。",
        en: "Look up at this row of arcades. The arches along the ground floor are Roman in style, the coloured-glass windows above are called Manchu windows, and the ornament on the parapet is a relief gable. Western arches and Lingnan windows on one façade: that is the East-meets-West character of Changdi's qilou."
      },
      sources: ["携程景点页「长堤风貌街」"]
    },
    {
      id: "CD-S02",
      name: "新市路",
      name_en: "Xinshi Road",
      category: "老街",
      key: true,
      card: "assets/card-xinshi.jpg",
      cardName: "取景老街",
      hotspot: { x: 2, y: 68, w: 22, h: 6 },
      oneLine: "电视剧《狂飙》取景的老街。",
      intro: "新市路是长堤历史文化街区的一部分，电视剧《狂飙》曾在这里取景。",
      guide: {
        zh: "这条往内街延伸的路叫新市路，也属于长堤历史文化街区。电视剧《狂飙》在这里取过景，不少游客专门来找同一个机位拍照。",
        yue: "呢条向内街伸入去嘅路叫新市路，都系长堤历史文化街区嘅一部分。电视剧《狂飙》喺度取过景，好多游客专登嚟揾同一个机位影相。",
        en: "This street heading inland is Xinshi Road, part of the Changdi historic district. The TV drama 'The Knockout' filmed scenes here, and many visitors come looking for the same camera angles."
      },
      sources: ["携程景点页「长堤风貌街」", "澎湃新闻报道"]
    },
    {
      id: "CD-S03",
      name: "墟顶老街",
      name_en: "Xuding Old Street",
      category: "老街",
      key: true,
      card: "assets/card-xuding.jpg",
      cardName: "明代墟集",
      hotspot: { x: 6, y: 75, w: 19, h: 13 },
      oneLine: "老墟街，影视取景地。与长堤的边界待核实。",
      intro: "墟顶老街（三十三墟街）是江门老城的老街之一，也出现在影视取景中。长堤一带自明代形成墟集，这条街的具体范围及与长堤的位置关系待核实。",
      guide: {
        zh: "墟，就是集市。长堤一带从明代起就形成了墟集，后来才有了沿江的商号和骑楼。墟顶老街也叫三十三墟街，也是影视取景地。它和长堤的具体边界，我们还在核实。",
        yue: "墟，即系趁墟嘅墟，就系市集。长堤一带由明代开始就有墟集，后来先至有沿江嘅商号同骑楼。墟顶老街又叫三十三墟街，都系影视取景地。佢同长堤嘅具体边界，我哋仲核实紧。",
        en: "A 'xu' is a market. Markets formed around Changdi as early as the Ming dynasty, long before the riverside shops and arcades. Xuding Old Street, also called Thirty-Three Market Street, has also been used as a filming location. Its exact boundary with Changdi is still being verified."
      },
      sources: ["凤凰网《江门墟兴 老城脉续》", "携程游记"]
    },
    {
      id: "CD-P01",
      name: "沿江停车场（示范）",
      name_en: "Riverside Parking (demo)",
      category: "停车",
      key: false,
      parking: "P1",
      hotspot: { x: 43, y: 83, w: 17, h: 7 },
      oneLine: "示范数据：余位与预测均为模拟。",
      intro: "这是用于演示停车功能的示范停车场，余位与预测数据均为模拟，接入需求方停车数据后替换。",
      guide: null,
      sources: []
    },
    {
      id: "CD-R02",
      name: "江门铁桥",
      name_en: "Jiangmen Iron Bridge",
      category: "地标",
      key: false,
      hotspot: { x: 50, y: 91, w: 48, h: 6 },
      oneLine: "长堤历史文化街区的西端终点。",
      intro: "按公开资料，长堤历史文化街区西至江门铁桥。走到这里，整条长堤就走完了。",
      guide: {
        zh: "走到江门铁桥，长堤就到头了。回头看，一点五公里的骑楼沿江排开，这就是江门城区开始的地方。",
        yue: "行到江门铁桥，长堤就行完喇。返转头望，一点五公里嘅骑楼沿住江排开，呢度就系江门城区开始嘅地方。",
        en: "At the Jiangmen Iron Bridge, Changdi comes to an end. Look back: a kilometre and a half of arcades along the river, where the city of Jiangmen began."
      },
      sources: ["携程景点页「长堤风貌街」"]
    }
  ],

  // 故事线：节点只用有出处的内容串联
  stories: [
    {
      id: "ST01",
      title: "从墟集到商埠",
      summary: "沿着长堤，看一条集市怎样变成通商口岸的商业街。",
      nodes: [
        { point: "CD-S03", text: "明代，长堤一带形成墟集，人们在这里趁墟买卖。" },
        { point: "CD-A02", text: "1904 年，江门辟为对外通商口岸。" },
        { point: "CD-S01", text: "开埠后商号林立，沿江建起数百间中西合璧的骑楼。" },
        { point: "CD-A03", text: "江边的石阶码头，连着水路与街市。" },
        { point: "CD-A01", text: "今天，晚清民初的双联骑楼成了博物馆分馆。" }
      ]
    }
  ],

  // 路线规划：三条候选路线，按兴趣排序后展示
  routes: [
    {
      id: "R1",
      name: "经典必看",
      color: "#e07a5f",
      minutes: 45,
      meters: 1100,
      points: ["CD-V01", "CD-A02", "CD-A01", "CD-A03", "CD-S01"],
      reason: "五个最有代表性的点位，沿江一路向西，不走回头路。",
      tags: ["建筑", "历史"]
    },
    {
      id: "R2",
      name: "从墟集到商埠",
      color: "#3d8bab",
      minutes: 60,
      meters: 1400,
      points: ["CD-S03", "CD-S02", "CD-S01", "CD-A02", "CD-A03", "CD-A01"],
      reason: "按故事线顺序走，先看老墟街，再看开埠后的骑楼和码头。",
      tags: ["历史", "人物"]
    },
    {
      id: "R3",
      name: "轻松少走",
      color: "#7a9e5a",
      minutes: 30,
      meters: 600,
      points: ["CD-P01", "CD-S01", "CD-A03", "CD-A01"],
      reason: "从停车场出发，只走沿江一段，步行约 600 米，适合带老人小孩。",
      tags: ["拍照", "轻松"],
      drive: true
    }
  ],

  interests: ["侨乡历史", "骑楼建筑", "人物故事", "影视取景", "拍照", "美食咖啡"],

  // 以下为示范数据，页面上必须标注「示范数据」
  guides: [
    { id: "G1", name: "讲解员 A", langs: ["普通话", "粤语"], level: "金牌", rating: 4.9, topics: "骑楼建筑、侨乡历史", slots: ["10:00", "14:00", "16:00"] },
    { id: "G2", name: "讲解员 B", langs: ["普通话", "English"], level: "银牌", rating: 4.7, topics: "开埠历史、外语讲解", slots: ["09:30", "15:00"] },
    { id: "G3", name: "讲解员 C", langs: ["粤语", "客家话"], level: "银牌", rating: 4.8, topics: "老街生活、方言故事", slots: ["11:00", "15:30", "17:00"] }
  ],
  parking: [
    { id: "P1", name: "沿江停车场", total: 120, free: 18, walk: 150, walk_minutes: 2, updated: "2 分钟前",
      updated_at: "2026-04-10T13:58:00+08:00", source: "synthetic",
      fee: { mode: "hourly", amount: 5, unit: "CNY", note: "5 元/小时（示范）" },
      access: { open_hours: "00:00-24:00", one_way: false, restricted_hours: [], height_limit_m: null,
        note: "沿江路单行道，需从水埠头方向进入（示范）" },
      past: [62, 48, 35, 26, 18], forecast: [12, 8, 10, 15],
      reason: "离水埠头最近，停车后步行约 2 分钟；但 1 小时内可能停满。" },
    { id: "P2", name: "内街停车场", total: 80, free: 41, walk: 450, walk_minutes: 6, updated: "5 分钟前",
      updated_at: "2026-04-10T13:55:00+08:00", source: "synthetic",
      fee: { mode: "hourly", amount: 4, unit: "CNY", note: "4 元/小时（示范）" },
      access: { open_hours: "06:00-24:00", one_way: true,
        restricted_hours: [{ from: "07:00", to: "09:00", note: "早高峰只出不进（示范）" }],
        height_limit_m: 2.2, note: "内街单行（示范）" },
      past: [55, 52, 47, 44, 41], forecast: [38, 36, 37, 40],
      reason: "余位充足，步行约 6 分钟到骑楼街，适合现在出发的游客。" }
  ],
  feedbackTypes: ["环境卫生", "设施损坏", "噪音扰民", "导览内容有误", "其他"]
};
