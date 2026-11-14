# SOLA TALK

アカウント不要・最大5人のブラウザ通話サイト。Zoom風UI、夕日テーマ2種類。

## 構成
- Flask + Flask-SocketIO: ルーム、承認、管理、WebRTCシグナリング
- ブラウザ WebRTC: P2P音声・ビデオ・画面共有
- JavaScript / CSS: 通話画面、チャット、テーマ
- Python 3.12 推奨

## 開発環境
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```
http://localhost:5000 を開く。

## Render デプロイ
Blueprint を使う場合は render.yaml を利用。通常のWeb Serviceなら:
- Build: `pip install -r requirements.txt`
- Start: `gunicorn --worker-class gthread --workers 1 --threads 8 --bind 0.0.0.0:$PORT app:app`
- `SECRET_KEY`: 安全なランダム文字列
- Socket.IOのルーム状態はメモリ保存のため**1 worker**で運用

## 初期実装と制限
- ルーム作成、URL参加、パスワード、最大2〜5人、参加承認、ロック、退室、全員終了
- 表示名をブラウザ保存、暗い/明るい夕日テーマ、チャット、招待URL
- WebRTC P2P通話、低解像度映像、最大720p/10fpsの画面共有を試す初期版
- マイク・カメラのブラウザ許可が必要。RenderなどHTTPSサイト、またはlocalhostで利用
- STUNのみ。ネットワークの組合せによりTURNサーバーが必要で、接続できない場合あり
- 最大5人全員の通話・画面共有の快適さは保証されない
- 複数画面共有の映像タイル・各発言者の検出・回線品質・再接続/管理者復帰などは**未完成**。このコードは最初の動作検証用
- メモリ上のルームはRender再起動・スリープで消える。管理キーは現在のブラウザタブのsessionStorageに保存。タブを閉じた場合復帰できない
- URLを知っていればルーム情報を確認できる。ルームURLやパスワードは信頼できる相手だけに共有
- ファイルや通話内容のサーバー保存・録画は実装していない

## 次の改善
- 全員同時の画面共有を正しく扱う追加トラック/映像タイル設計
- WebRTC negotiation collision/ICE candidate bufferingと再接続の強化
- 管理者の退出操作UIと通知、QRコード、SOLA CHATへの共有
- 必要ならTURN、永続ルームDB、実機5人テスト

無料構成を優先しているため、品質や安定性に技術的な限界があります。
