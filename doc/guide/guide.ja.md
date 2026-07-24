[English](guide.en.md) | [Русский](guide.ru.md) | 日本語

# briefboard — ユーザーガイド

これは詳細な手順ガイドです。briefboard のインストールから日々の運用までを説明
します。[README](../../README.md) は「何を/なぜ + クイックスタート」という短い
概要ですが、本ドキュメントはさらに踏み込み、ワークフロー全体を通して案内します。
技術用語・ファイル名・コマンド・環境変数は、まさにあなたが入力するものなので、
すべてそのまま（ラテン文字のまま）表記します。

## 目次

1. [はじめに — briefboard とは](#1-はじめに--briefboard-とは)
2. [要件](#2-要件)
3. [インストール](#3-インストール)
4. [初回起動](#4-初回起動)
5. [ロールと AGENTS.md](#5-ロールと-agentsmd)
6. [タスクのライフサイクル（最初から最後まで）](#6-タスクのライフサイクル最初から最後まで)
7. [CLI リファレンス](#7-cli-リファレンス)
8. [良いブリーフの書き方](#8-良いブリーフの書き方)
9. [ボードの見方（UI）](#9-ボードの見方ui)
10. [pre-commit フック](#10-pre-commit-フック)
11. [FAQ とトラブルシューティング](#11-faq-とトラブルシューティング)

## 1. はじめに — briefboard とは

briefboard（リポジトリは `agentboard` とも呼ばれます）は、軽量なかんばんボードと
コマンドラインツールの組み合わせであり、AI コーディングエージェントに厳格で明示的
なワークフロー `backlog → open → ready → in_progress → review → done` に沿って
作業させるものです。このワークフローで必須となるものは 2 つ — 実装開始前に書かれた
ブリーフと、マージ前のレビューです。

その狙いは、素のチャット会話には欠けている構造をエージェントの作業に与えることに
あります。決定事項がスクロールバッファの中だけに存在するのではなく、各タスクは
プレーンな markdown ファイル（`doc/backlog.md`）内のセクションであり、各作業単位に
はその範囲と受け入れ基準を定義するブリーフ（`doc/brief/`）があり、そして人間は
ライブボード上でそのすべてがリアルタイムに動くのを見守ることができます。短い版と
プロジェクトの背景については [README](../../README.md) を参照してください。

## 2. 要件

- **Node.js >= 21。** これは `package.json` の `engines.node` によって強制されて
  います。理由は経験的なもの（タスク T-0041 を参照）です。`node --test` は、
  `npm test` からの glob パターン `tests/**/*.test.js` を Node 21.0.0 以降でのみ
  展開し始めます。Node 18.x および 20.x ライン全体 — 最新リリース 20.20.2 まで —
  では同じパターンが 1 つもファイルにマッチせず、テストスイートは黙って何も実行
  しません。
- **Zero runtime dependencies。** `npm install` の手順はなく、実行時のサードパー
  ティライブラリもありません。サーバー・CLI・UI は Node の標準ライブラリと
  vanilla JavaScript のみを使用します。
- **OS 非依存。** briefboard は Node 21+ が動くところならどこでも動作します —
  Linux、macOS、Windows。状態はすべてディスク上のプレーンな markdown であり、
  アトミック書き込みパターン（`.tmp` ファイルに書いてから rename）は POSIX と
  NTFS の両方でアトミックです。

## 3. インストール

始める方法は 2 つあります。既存のプロジェクトに briefboard を追加したい場合は
(a) を、briefboard リポジトリ自体の中で作業したい場合は (b) を選んでください。

### (a) `npx briefboard init`

パッケージは `briefboard` という名前で npm に公開されているので、これがプロジェ
クトに追加する標準的な方法です:

```bash
npx briefboard init
```

`init` コマンドは、ボードのランタイムファイル — `server/`、`tools/`、`ui/`、
`agents/`、`AGENTS.md`、`CLAUDE.md` — をパッケージから現在のディレクトリにコピー
し、そのプロジェクト用に空の `doc/backlog.md` と空の `doc/brief/` ディレクトリを
生成します。冪等です: 宛先にある既存のファイルやディレクトリが上書きされることは
決してなく、再実行はまだ存在しないものだけを埋めます（既にあるものについては
`skip existing: ...` と表示します）。

### (b) `git clone` してリポジトリの中で作業する

```bash
git clone <url-of-this-repository>
cd agentboard
```

これだけです — インストールするものはありません。コードは `init` がコピーするもの
と同一で、すべてをクローンしたリポジトリの中から実行します。これはコントリビュー
ターやローカル開発向けの推奨経路です。

## 4. 初回起動

ボードサーバーを起動します:

```bash
node server/server.js
```

デフォルトでは、ボードは `http://127.0.0.1:4571` で配信されます。その URL を
ブラウザで開くと、かんばんボードが表示されます。

- **`PORT`** — ポートを変更します。例: `PORT=8080 node server/server.js` は
  ボードを `http://127.0.0.1:8080` で配信します。デフォルトは `4571` です。
- **デフォルトは loopback。** サーバーは `127.0.0.1`（loopback）にバインドする
  ので、ボード — および唯一の書き込みエンドポイント `POST /api/task/:id/cancel`
  — はローカルマシンからのみ到達可能です。これは意図的です: 認証はありません。
- **公開バインドはオプトイン。** ボードをネットワークに公開するには、`HOST` また
  は `AGENTBOARD_HOST` でホストを明示的に指定します（例:
  `HOST=0.0.0.0 node server/server.js`）。バインドホストが loopback でない場合、
  サーバーはボードと書き込みエンドポイントが認証なしで公開されているという
  `WARNING` を表示します。完全なネットワークモデルは
  [SECURITY.md](../../SECURITY.md) を参照してください。
- **`AGENTBOARD_ROOT`** — サーバー（と CLI）を別プロジェクトの `doc/` に向け、
  1 つのインストールで多くのプロジェクトを扱えるようにします。例:
  `AGENTBOARD_ROOT=/path/to/project node server/server.js`。
- **`MAX_SSE_CLIENTS`** — 同時のライブ更新（SSE）接続数の上限。デフォルトは
  `50` です。

## 5. ロールと AGENTS.md

briefboard は 2 つのロールを定義しており、プロセス全体はそれらを分離しておくこと
に依存します。正規のルールは `AGENTS.md`（どのエージェントツールを使うにせよ、
最初に読んでください）にあり、フォーマット契約は `agents/PROTOCOL.md` に、ロール
ごとの指示は `agents/ORCHESTRATOR.md` と `agents/WORKER.md` にあります。

- **オーケストレーター** — デフォルトのロール。バックログを所有します: タスクの
  記録とグルーミング、ブリーフの執筆、作業の割り当て、レビューの実施、マージを
  行います。ステータス `backlog`、`open`、`ready`、`review`、`done`、`cancelled`
  を設定できる唯一のロールです。タスクを自分で実装することはなく、実装はワーカーに
  委任します。
- **ワーカー** — `ready` にあるタスクを取り、ブリーフに記述されたことを（それ
  以上ではなく）まさに実装し、許可された唯一の 2 つの遷移でタスクを進めます:
  `ready → in_progress`（タスクを取る）と `in_progress → review`（提出する）。

**なぜブリーフが必須なのか:** タスクは少なくとも 1 つのブリーフがなければ `ready`
へ移せません — CLI がその遷移を拒否します。ブリーフはオーケストレーターとワーカー
の間の契約です: コードが 1 行も書かれる前に範囲と受け入れ基準を確定するので、
ワーカーは自分がいつ完了したのかを正確に把握でき、オーケストレーターは何を基準に
レビューすればよいのかを正確に把握できます。

## 6. タスクのライフサイクル（最初から最後まで）

作成からマージまでの完全なタスクを、各ステップの実際のコマンドとともに示します。
ステータス図（`agents/PROTOCOL.md` に載っているものと同じ）:

```
backlog ──▶ open ──▶ ready ──▶ in_progress ──▶ review ──▶ done
   │          │        │            │             │
   └──────────┴────────┴────────────┴─────────────┴──▶ cancelled
                                        review ──▶ in_progress (レビュー不合格の場合)
```

ステップごと:

1. **タスクを作成する**（オーケストレーター）。`backlog` に入ります:

   ```bash
   node tools/task.mjs add --type feature --priority Major \
     --title "Add CSV export" --desc "Export the board to CSV as well as xlsx"
   ```

   新しい ID（例: `T-0007`）を表示します。

2. **グルーミングして open にする**（オーケストレーター）。タスクが議論され決定が
   下されたら、`open` に移します:

   ```bash
   node tools/task.mjs status T-0007 open
   ```

3. **ブリーフを書く**（オーケストレーター）。ブリーフファイルを生成し、タスクに
   紐づけます:

   ```bash
   node tools/task.mjs brief T-0007 csv-export
   ```

   これは `doc/brief/T-0007-01-csv-export.md` を作成し、タスクの `briefs`
   フィールドに `T-0007-01` を追加します。ブリーフを埋めてください（
   [良いブリーフの書き方](#8-良いブリーフの書き方) を参照）。

4. **ready にする**（オーケストレーター）。ブリーフがあれば、タスクを `ready` に
   移せます:

   ```bash
   node tools/task.mjs status T-0007 ready
   ```

   （ブリーフを書く前にこれを試すと、CLI は拒否します: ブリーフのないタスクは
   `ready` にできません。）

5. **タスクを取る**（ワーカー）: `ready → in_progress`、その後は別ブランチで作業:

   ```bash
   node tools/task.mjs status T-0007 in_progress
   ```

6. **レビューに提出する**（ワーカー）: 受け入れ基準が満たされテストが緑になったら、
   `in_progress → review`:

   ```bash
   node tools/task.mjs status T-0007 review
   ```

7. **レビューしてクローズする**（オーケストレーター）。オーケストレーターは作業を
   レビューしテストを実行します。何か問題があれば、コメント付きでタスクを差し戻し
   ます（`review → in_progress`）。合格してマージされたら、オーケストレーターは
   `done` を設定します:

   ```bash
   node tools/task.mjs status T-0007 done
   ```

   タスクが不要だと判明した場合、任意のオープンな状態（`backlog`、`open`、
   `ready`、`in_progress`、`review`）から `cancelled` にできます。`done` または
   `cancelled` を設定すると `closed` 日時が刻まれます。

## 7. CLI リファレンス

タスクの変更はすべて `node tools/task.mjs` を通します。これはファイル形式・連番
ID・アトミック書き込みを保証します。サブコマンドは `add`、`status`、`brief`、
`show`、`list`、`validate` — これらだけです。

### `add` — 新しいタスクを作成する

```bash
node tools/task.mjs add --type feature --priority Major --title "..." --desc "..."
```

`doc/backlog.md` に新しいタスクを（ステータス `backlog` で）作成し、その ID を
表示します。フラグ:

- `--type` — `feature` または `bug`（`bug` 以外は `feature` として扱われます）。
- `--priority` — `Blocker`、`Critical`、`Major`、`Medium`、`Minor` のいずれか
  （それ以外は `Medium` にフォールバックします）。
- `--title` — タスクのタイトル。**必須。**
- `--desc` — 自由記述の説明（任意）。

### `status` — タスクのステータスを変更する

```bash
node tools/task.mjs status T-0007 ready
```

値と遷移の両方を検証しつつステータスを設定します。対象は `backlog`、`open`、
`ready`、`in_progress`、`review`、`done`、`cancelled` のいずれかでなければなりま
せん。遷移はライフサイクルグラフに従う必要があります:
`backlog → open → ready → in_progress → review → done`、任意の非終端ステータス
→ `cancelled`、および作業を差し戻すための `review → in_progress`。不正な遷移
（例: `ready → done`）は、現在のステータスから許可されている移行を列挙するエラー
で拒否されます。`done` と `cancelled` は終端です。現在の値と同じ値への設定は冪等
な no-op です。

手動修正のためにグラフを回避するには `--force` を付けます — これは有効なステータ
ス間の任意の移行を許可し、stderr に `WARNING` を出力します。`--force` はフォーマッ
ト不変条件を回避**しません**: `ready` への移行はタスクにブリーフがないと依然とし
て拒否されます。`done` または `cancelled` への移行は（`--force` の有無にかかわら
ず）`closed` タイムスタンプを刻みます。

### `brief` — ブリーフを生成して紐づける

```bash
node tools/task.mjs brief T-0007 csv-export
```

`doc/brief/T-0007-NN-slug.md`（`NN` はそのタスク内でのブリーフの次の番号）を標準
のセクション骨格とともに作成し、ブリーフ ID をタスクの `briefs` フィールドに追加
します。

### `show` — タスク全体を表示する

```bash
node tools/task.mjs show T-0007
```

タスク全体（すべてのフィールドと説明）を JSON として表示します。

### `list` — タスクを一覧表示する

```bash
node tools/task.mjs list
node tools/task.mjs list --status ready
```

タスクを一覧表示し、`--status` で任意にステータスでフィルタします。

### `validate` — 構造チェック

```bash
node tools/task.mjs validate
```

`doc/backlog.md` の構造チェックを実行します。重複 ID、無効な `status`/`type` の
値、壊れたヘッダー、存在しないブリーフへのリンクを検出します。ファイルが有効なら
`OK` を表示して終了コード `0` で終了し、そうでなければエラーを表示して終了コード
`1` で終了します。

## 8. 良いブリーフの書き方

ブリーフはタスクの契約です。ブリーフファイルは `doc/brief/T-NNNN-MM-slug.md` に
あり、最初の行は `# T-NNNN-MM · タイトル` というヘッダーで、4 つのセクションが
あります。`brief` サブコマンドがこの骨格を生成します。セクションのヘッダーは
英語で出力されます（`agents/PROTOCOL.md` のフォーマット規約に一致します）。
ここでは日本語の注釈を添えて示します:

```
# T-0007-01 · ブリーフのタイトル

## Context（コンテキスト）
なぜやるのか、議論へのリンク。

## Solution（解決策）
具体的に何をやるのか — アーキテクチャ、インターフェース。

## Scope（範囲）
何が含まれ / 何が含まれないか。

## Acceptance criteria（受け入れ基準）
- [ ] 項目 1
- [ ] 項目 2
```

実践的なアドバイス:

- **コンテキスト** — 解決策ではなく問題を述べること。決定が下された場所へリンク
  すること。
- **解決策** — 具体的に: どのファイル、どの関数、どのコマンドか。ワーカーが設計を
  推測せずに済むように。
- **範囲** — 何が明示的に範囲*外*かを明記すること。これがタスクの肥大化を防ぎ
  ます。
- **受け入れ基準** — 各項目を検証可能にすること。「テストが緑」「`validate` が
  通る」は良い基準ですが、「うまく動く」はそうではありません。

ブリーフとバックログの完全なフォーマット契約は
[`agents/PROTOCOL.md`](../../agents/PROTOCOL.md) にあります; これがフォーマットの
唯一の真実の源です。

## 9. ボードの見方（UI）

`http://127.0.0.1:4571` をブラウザで開きます。ボードはタスクを表示し、次のコント
ロールを提供します:

- **ステータス別の列。** Backlog → Open → Ready → In progress → Review がボードを
  横断する列です。Done と Cancelled はボードの下にある折りたたみ可能なストリップ
  で、クローズした作業がアクティブな列を圧迫しないようにします。
- **タイプでのフィルタ。** すべてのタスク、`feature` のみ、または `bug` のみを
  表示します。
- **全文検索。** タスクのタイトルと説明を検索します。
- **優先度の複数選択フィルタ。** `Blocker`、`Critical`、`Major`、`Medium`、
  `Minor` の任意の組み合わせでフィルタします。
- **テーマ切り替え。** ライトテーマとダークテーマを切り替えます。
- **言語切り替え。** `<select>` コントロールでインターフェース言語を EN、RU、JA
  の間で切り替えます。
- **ドラッグ&ドロップでキャンセル。** Backlog または Open 列からカードを
  Cancelled ストリップにドラッグして、UI から直接キャンセルします。まず確認を
  求め、その後、狭いエンドポイント `POST /api/task/:id/cancel` を通じて
  `backlog`/`open` → `cancelled` の遷移を実行します。
- **Excel へのエクスポート。** 「Export Excel」ボタンで現在のボードを本物の
  `.xlsx` ファイルとしてダウンロードします。
- **ライブ更新。** `doc/backlog.md` がディスク上で変わると、ボードは自動的に再
  描画されます — Server-Sent Events（SSE）と `fs.watch` を使うので、ページを
  再読み込みする必要はありません。

## 10. pre-commit フック

リポジトリには、コミットのたびに `node tools/task.mjs validate` を実行する
pre-commit フックが `.githooks/pre-commit` に付属しています。検証に失敗すると、
コミットはブロックされ、エラーが表示されます。

このフックは（git で versioning されない）`.git/hooks/` ではなく、（git で
versioning される）`.githooks/` 配下にあります。次の 1 回限りのコマンドでオプト
インして初めて有効になります:

```bash
git config core.hooksPath .githooks
```

このセットアップがないと、git はフックをまったく実行しません — リポジトリが自身で
フックを自動的に有効化する方法はありません。有効にする価値はあります: 壊れた
`doc/backlog.md`（重複 ID、壊れたヘッダー、宙ぶらりんのブリーフリンク）が
コミットされるのを防ぎます。

## 11. FAQ とトラブルシューティング

**ポートがすでに使われている。** 別のプロセスが `4571` を握っています。別のポート
でサーバーを起動してください:

```bash
PORT=8080 node server/server.js
```

**何も動かないように見える / テストスイートがファイルにマッチしない。** おそらく
Node < 21 です。症状は、`node --test`（`npm test` 経由）が glob パターン
`tests/**/*.test.js` からファイルを展開せず、黙ってゼロ個のテストを実行することで
す。バージョンを確認してください:

```bash
node -v
```

`21.0.0` 未満なら Node をアップグレードしてください。[要件](#2-要件) を参照。

**`doc/backlog.md` が壊れているように見える。** 何が問題かを正確に知るために
バリデーターを実行してください:

```bash
node tools/task.mjs validate
```

重複 ID、壊れたヘッダー、無効な `status`/`type` の値、存在しないブリーフへの宙
ぶらりんのリンクを検出します。報告された問題を修正し、`OK` と表示されるまで再度
実行してください。

**ボードが別のマシンから到達できない。** これは by design です。サーバーは
loopback（`127.0.0.1`）にバインドし、ボードとその書き込みエンドポイントが認証
なしで公開されないようにしています。本当にネットワークバインドが必要な場合は、
`HOST` または `AGENTBOARD_HOST` を明示的に設定し（例:
`HOST=0.0.0.0 node server/server.js`）— サーバーは `WARNING` を表示します — まず
[SECURITY.md](../../SECURITY.md) を読んでください。
