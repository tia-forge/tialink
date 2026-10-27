# tialink-batch

用**点表批量生成**西门子 TIA Portal（博途）工程对象的命令行工具：一个模板 FB，一份 CSV，把 N 台同类设备的块、背景 DB、IO 变量、调用段一次性建好，并且先预检、不自动保存。

> 面向真实项目里最枯燥的那部分工作：一条线上 8 台泵、20 台风机、200 个工位，逻辑一样，**但名字、块号、IO 地址、延时都不一样**。

依赖：Node.js 18+（自带 fetch）、本机运行中的 [TiaLink](https://tia.hubwiz.com/tia-link)（默认 `http://localhost:8080`）。**没有任何 npm 依赖。**

```
$ node tialink-batch.mjs clone --template FB_MotorSeq --spec examples/fans.csv --mode copy --base 200 --db-base 200 --tags Fans_IO --calls FB_FanCalls
模板 FB_MotorSeq：3 Bool 入 / 2 Bool 出；点表 8 台（Fan01 … Fan08），模式 copy；准备 1325 ms
  ✓ FB × 8（copy）         1920 ms （8 个对象）
  ✓ 背景 DB × 8            1815 ms （8 个对象）
  ✓ 变量表 Fans_IO（8 台）    2594 ms （+40 变量）
  ✓ 调用段 FB_FanCalls      674 ms
编译 2523 ms：errors=0 warnings=1 state=Warning
工程 test9：dirty=true（TiaLink 不会替你保存，保存由人决定）
```

---

## 为什么不是"复制粘贴"

把一台设备的程序复制成 N 台，手工做要同步改 **4 类东西**，漏一个就可能编译通过却跑错：

| 差异类别 | 例子 | 漏了会怎样 |
|---|---|---|
| 标识 | 块名、块号、背景 DB 名 | 编译报"地址含混不清"或两个块抢同一个号 |
| 引用 | 背景 DB 的 `InstanceOf` 指向哪个 FB | 编译报"实例与接口不匹配" |
| IO 地址 | 点表里不连续、中间夹着别的信号 | 编译**只给一条警告**（地址不在硬件组态里），下载后是两个设备抢同一个点 |
| 参数与文本 | 延时、量程、阈值、注释里的台号 | 编译 0 错误，现场调试才发现某台的延时还是模板值 |

这份脚本把前三类做成**数据驱动**（点表），第四类做成**替换规则**，剩下的判断留给人。

## 点表格式

CSV，第一行列名 = **模板 FB 的接口成员名**（大小写敏感）：

```csv
no,name,Start,StopPermit,Fault,RunDelay,Motor1,Motor2
1,Fan01,%I10.0,%I10.1,%I10.2,T#6S,%Q10.0,%Q10.1
2,Fan02,%I10.3,%I10.4,%I10.5,T#9S,%Q10.2,%Q10.3
3,Fan03,%I11.0,%I11.1,%I11.2,T#12S,%Q11.0,%Q11.1
```

- `no` / `name`：台号与设备名（决定块名、DB 名、变量名前缀、注释里的台号）
- Bool 成员 → 一格里填地址（`%I` / `%Q` / `%M` 都行），脚本据此建变量表
- 非 Bool 成员 → 填字面值（`T#6S`、`100.0`、`'ABC'`），写进副本的默认值 / 调用实参
- 其它列会被忽略并提示

脚本会先检查两件人工复制时最容易犯的错：**地址写重**、**块号撞车**。

## 两种复制模式

| | `--mode instance`（推荐） | `--mode copy` |
|---|---|---|
| 生成什么 | 1 个模板 FB + **N 个背景 DB** | **N 个 FB 副本** + N 个背景 DB |
| 每台的差异 | 全部在调用时传入（点表 → 实参） | 部分固化进块内（默认值、注释） |
| 适合 | 逻辑完全一样，只是点位/参数不同 | 每台的**代码本身**要有差别（联锁数不同、带不带变频器） |
| 代价 | 改一次 FB，全部生效 | 改模板要重跑一遍；N 份代码要分别 review |

**先问一句"真的需要复制块吗"**：能用「1 个 FB + N 个背景 DB + 数组」解决的就别复制块。复制块只在"代码要分叉"时才值得。

## 用法

```bash
# 1) 批量生成（先加 --dry 看预检，不写工程）
node tialink-batch.mjs clone --host http://192.168.1.110:8080 --device PLC_1 \
  --template FB_MotorSeq --spec examples/fans.csv \
  --mode copy --base 200 --db-base 200 \
  --tags Fans_IO --calls FB_FanCalls \
  --replace '1 号电机={no} 号风机主电机' \
  --replace '2 号电机={no} 号风机备电机'

# 2) 把一个 CPU 的块整体导出成 zip（含 manifest.json）
node tialink-batch.mjs export --device PLC_1 --kinds blocks,tagTables --zip plc1.zip

# 3) 搬到另一个 CPU / 另一个工程（按 UDT → FB/FC/OB → 实例 DB → 变量表 排序，分批发送）
node tialink-batch.mjs import --zip plc1.zip --to PLC_2 --chunk 100
```

| 参数 | 说明 |
|---|---|
| `--template` | 模板块名（FB/FC）。接口从导出结果里读，不需要手写 |
| `--spec` | 点表 CSV |
| `--mode` | `instance`（默认）/ `copy` |
| `--base` / `--db-base` | FB 与背景 DB 的起始编号；不写就取当前最大号 +1 |
| `--tags` | 新建/覆盖的变量表名；不给就不建变量表 |
| `--calls` | 生成一个"调用段"FB 的名字（SCL 外部源），一个块里排好 N 段调用 |
| `--replace` | 文本替换规则，可重复；支持 `{no}` `{name}` 占位 |
| `--dry` | 预检模式：只回报将要创建/覆盖什么，不写工程 |
| `--chunk` | `import` 时每个请求装多少个同种对象（默认 100） |

公共参数：`--host`（默认 `http://localhost:8080`）、`--device`。

## 实测（TIA V19 / S7-1500 / TiaLink，单机）

| 场景 | 结果 | 用时 |
|---|---|---|
| 8 台泵，`copy` 模式（8 FB + 8 DB + 40 变量 + 调用段） | 编译 0 错误 | ≈9 s + 编译 2.5 s |
| 200 台，`instance` 模式（200 DB + 1000 变量 + 200 段调用） | 编译 0 错误 | ≈58 s + 编译 10 s |
| 208 个对象跨 CPU 搬运（205 块 + 2 变量表，486 KB） | 编译 0 错误 | 导出 13.7 s + 导入 59 s + 编译 42 s |

单次请求的规模：一个 `<Document>` 装 20 个 FB 用时 3.9 s，装 100 个实例 DB 用时 13 s——**对象越多，边际成本越低**，因为真正的开销在工程事务而不是传输。

## 六个坑（TIA / SimaticML 层面，实测踩过）

1. **多个根对象在同一 `<Document>` 里，`ID` 必须全局唯一** —— 直接把 N 份 XML 拼起来会报
   `Duplicate Simatic ML ID '0' found at line 430 / line 50`。
2. **`ID` 是十六进制字符串，`UId` 是十进制 int32**。按十六进制平移 `UId`，前 8 台侥幸通过，第 10 台（`0xA000`）就炸：
   `"UId" 属性无效 … "A003" 不是有效的 Int32 值`。
3. **`<AutoNumber>true</AutoNumber>` 会让 `<Number>` 失效** —— 想固定块号，必须改成 `false`。
4. **预检只回报第一个根对象**：一个文档里装 20 个块，预检结果里只有 1 条。别据此判断"只导了一个"。
5. **导入顺序 = 依赖顺序**：实例 DB 先于它的 FB 导入，报错是 `Block 'FB_X' does not exist at the object with UID ''`（完全看不出真实原因）。
   正确顺序：UDT → FB/FC/OB → 实例 DB → 变量表。
6. **合成实例 DB 时，FB 的 `Temp` / `Constant` 段必须删掉**，报错只说 `"Temp"部分对此块无效`，不说是哪里来的。

另外两条只能靠人去处理的：

- **编译通过 ≠ 地址正确**：IO 地址不在硬件组态里时，只给一条 `Inputs or outputs are used that do not exist in the configured hardware` 警告。
- **文本替换有上限**：注释里"2 号电机在 1 号运行 RunDelay 之后启动"这种半结构化句子，规则替换只能改一半。
  真正的解法是**别把差异写进注释**——用参数、常量或变量表达，让差异出现在接口里，而不是散在文字里。

## 边界

- 只处理 PLC 侧的 SimaticML（块、UDT、变量表）与 SCL 外部源；**WinCC Unified 屏幕不能这样复制**（Openness 不导出）
- 不碰 F-CPU / 安全块（Safety 的复制有额外规则，必须人工走）
- 不自动保存工程：全程只在内存里改，`/health` 会一直显示 `dirty=true`，**保存由人决定**
- 生成的代码仍需按项目的验证流程走：编译 → 仿真 → 现场；工具负责"少抄几遍、少错几个地址"，工程责任仍在人

## 相关

- [TiaLink](https://tia.hubwiz.com/tia-link) —— 把 TIA Portal Openness 封装成 HTTP / MCP 网关，本脚本通过它的 REST 接口工作
- [博途批量复制设备程序：用点表替代复制粘贴](https://www.hubwiz.com/blog/tia-portal-batch-copy-from-spreadsheet/) —— 这份 README 的来源文章：四类差异、实测耗时与六个坑
- [梯形图转 SCL 迁移指南](https://www.hubwiz.com/blog/lad-to-scl-migration-guide-tia-portal/) —— 同类"能自动做什么、哪些必须人工"的边界讨论

## License

MIT

---

### English summary

CLI that batch-generates TIA Portal objects from a CSV spec: clone one template FB into N devices (FB copies and/or instance DBs), create the IO tag table from the spreadsheet's real addresses, and emit one SCL block with all N call sites. Dry-run first, never auto-saves. No npm dependencies — Node 18+ and a running [TiaLink](https://tia.hubwiz.com/tia-link) gateway.
