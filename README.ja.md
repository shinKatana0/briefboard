# briefboard (agentboard)

[English](README.md) | [Русский](README.ru.md) | 日本語

[![npm version](https://img.shields.io/npm/v/briefboard.svg)](https://www.npmjs.com/package/briefboard)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=21](https://img.shields.io/badge/node-%3E%3D21-brightgreen.svg)](#動作環境)

AIコーディングエージェントの作業を厳格なワークフロー
`backlog → open → ready → in_progress → review → done` に沿って進めさせる、
軽量なカンバンボード + CLI です。実装を始める前には必須のブリーフを、
マージの前にはレビューを求めます。

> このパッケージは `briefboard` という名前で npm に公開されています。
> `npx briefboard init` で任意のプロジェクトに展開できます
> （下記の[クイックスタート](#クイックスタート)を参照）。リポジトリの
> クローンは、コントリビューターや開発向けの代替手段です。

## なぜ必要か

チャットでの会話からそのまま作業するエージェントは、すぐに構造を失います。
何がすでに決まっているのか、何がまだ進行中なのか、ある判断を誰がなぜ下したのかが
分からなくなります。`agentboard`/`briefboard` は、任意のエージェント系ツール
（Claude Code、Codex など）の上に、シンプルで形式的なプロセスを載せます。
すなわち、タスクのバックログ、実装前の必須ブリーフ、マージ前のレビュー、
そしてそのすべてを人間にリアルタイムで見せるライブボードです。

## クイックスタート

**詳しいユーザーガイド:** インストール、初回起動、タスクのライフサイクル全体、
CLI リファレンス、ボード UI、トラブルシューティングまでを順を追って解説した
[ユーザーガイド](https://github.com/shinKatana0/briefboard/blob/main/doc/guide/guide.ja.md)
を参照してください。

`npx briefboard init` で任意のプロジェクトに展開できます。これは `server/`、
`tools/`、`ui/`、`agents/`、`AGENTS.md`、`CLAUDE.md` をカレントディレクトリに
コピーし、空の `doc/backlog.md` と `doc/brief/` を作成します。

```bash
npx briefboard init
node server/server.js
# → ボードは http://localhost:4571（ポートは PORT 環境変数で設定可能）

node tools/task.mjs add --type feature --priority Major --title "..." --desc "..."
```

代替手段として、コントリビューターや開発の場合はリポジトリをクローンして
その中で直接作業してください。

```bash
git clone <url-of-this-repository>
cd agentboard

node server/server.js
node tools/task.mjs add --type feature --priority Major --title "..." --desc "..."
```

## 仕組み

信頼できる唯一の情報源はプレーンな markdown である `doc/backlog.md`
（および `doc/brief/` 内のブリーフ）です。すべてのタスクは固定された一連の
ステータスを通過します。

```
backlog ──▶ open ──▶ ready ──▶ in_progress ──▶ review ──▶ done
   │          │        │            │             │
   └──────────┴────────┴────────────┴─────────────┴──▶ cancelled
                                        review ──▶ in_progress (if review fails)
```

- **backlog** — タスクが記録されただけの状態。
- **open** — 議論され、決定が下された状態。
- **ready** — ブリーフが書かれた状態（ブリーフなしに `ready` へは移せません）。
- **in_progress** — ワーカーがブリーフに従い、別ブランチでタスクを実装します。
- **review** — ワーカーがタスクを提出し、オーケストレーターが確認してテストを実行します。
- **done** / **cancelled** — タスクがマージされたか、キャンセルされた状態。

2つの役割があります。

- **オーケストレーター** — バックログを保有し、ブリーフを書き、タスクを割り当て、
  レビューとマージを行います。`backlog/open/ready/review/done/cancelled` を
  設定できる唯一の役割です。
- **ワーカー** — `ready` のタスクを取り、ブリーフに書かれた内容を正確に実装し、
  `ready → in_progress` と `in_progress → review` を移します。

`doc/backlog.md` と `doc/brief/*.md` の正確なフォーマット、記述ルール、
許可されるステータス遷移は `agents/PROTOCOL.md` にあります（フォーマットに関する
唯一の信頼できる情報源であり、この README はそれを言い換えているにすぎません）。
役割ごとの指示は `agents/ORCHESTRATOR.md` と `agents/WORKER.md` にあります。

## ボードのUI

- ステータス別のカラム: Backlog → Open → Ready → In progress → Review。
  Done と Cancelled はボードの下にある折りたたみ可能な帯です。
- タスク種別でのフィルター（all / feature / bug）。
- タスクのタイトルと説明に対する全文検索。
- 優先度での複数選択フィルター（Blocker / Critical / Major / Medium / Minor）。
- テーマ切り替え: light / dark。
- インターフェース言語の切り替え: EN / RU / JA。
- 「Backlog」/「Open」のカードを「Cancelled」の帯にドラッグ＆ドロップして、
  UIから直接タスクをキャンセルできます。
- 現在のボードをボタン1つで Excel（`.xlsx`）にエクスポート。
- ライブ更新: `doc/backlog.md` がディスク上で変更されると、ページを再読み込みせずに
  ボードが自身を再描画します（SSE + `fs.watch`）。

## CLIリファレンス

```bash
node tools/task.mjs add --type feature|bug --priority Blocker|Critical|Major|Medium|Minor --title "..." [--desc "..."]
                                  # doc/backlog.md に新しいタスクを作成する
node tools/task.mjs status T-0007 <backlog|open|ready|in_progress|review|done|cancelled>
                                  # タスクのステータスを変更する（遷移の妥当性を検証）
node tools/task.mjs brief T-0007 <slug>
                                  # doc/brief/T-0007-01-slug.md を作成しタスクに紐付ける
node tools/task.mjs show T-0007  # タスク全体を表示する（フィールド + 説明）
node tools/task.mjs list [--status ready]
                                  # タスクを一覧表示する（任意でステータスによりフィルター）
node tools/task.mjs validate     # doc/backlog.md の構造チェック（IDの重複、
                                  # 不正な status/type、壊れたブリーフへのリンクなど）
```

## 動作環境

- Node.js >= 21（経験的に確認済み、タスク T-0041 参照: `node --test` が `npm test`
  からの glob パターン `tests/**/*.test.js` を展開し始めるのは Node 21.0.0 以降です。
  Node 18.x および 20.x 系全体では、最新のリリース 20.20.2 に至るまで、同じパターンは
  1つのファイルにもマッチしません）。
- ランタイム依存ゼロ — `npm install` も、サードパーティ製ライブラリも不要です。

## セキュリティとネットワーク

デフォルトでは、サーバーは `127.0.0.1`（ループバック）にバインドするため、
ボードにアクセスできるのはローカルマシンからのみです。パブリックなバインドは
`HOST` / `AGENTBOARD_HOST` 環境変数によるオプトインです。ネットワークモデルと
脆弱性の報告方法は [SECURITY.md](SECURITY.md) を参照してください。

## コントリビュート

タスクのワークフロー、テストの実行方法、pre-commit フック、依存ゼロのスタイルに
ついては [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

MIT — [LICENSE](LICENSE) を参照してください。
