#!/usr/bin/env python3
"""
本地开发预览服务器（静态文件 + 白名单 /api/fetch 代理）
用于在桌面浏览器 localhost 下模拟 iOS 原生 fetchUrl 桥接，
实时测试微信读书、豆瓣读书、百度百科等全网多版本搜书。
"""
import http.server
import socketserver
import urllib.parse
import urllib.request
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
ALLOWED_HOSTS = {
    'weread.qq.com',
    'book.douban.com',
    'baike.baidu.com',
    'itunes.apple.com',
    'www.googleapis.com',
    'openlibrary.org',
}


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/fetch':
            qs = urllib.parse.parse_qs(parsed.query)
            target = (qs.get('url') or [''])[0]
            host = urllib.parse.urlparse(target).hostname or ''
            if host not in ALLOWED_HOSTS:
                self.send_response(403)
                self.end_headers()
                self.wfile.write(b'{"error":"host not allowed"}')
                return
            try:
                req = urllib.request.Request(
                    target,
                    headers={
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                        'Accept': 'application/json, text/plain, */*',
                    },
                )
                with urllib.request.urlopen(req, timeout=8) as resp:
                    body = resp.read()
                    ct = resp.headers.get('Content-Type', 'application/json; charset=utf-8')
                    self.send_response(resp.status)
                    self.send_header('Content-Type', ct)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(body)
            except Exception as e:
                self.send_response(502)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(('{"error":"' + str(e).replace('"', '\\"') + '"}').encode('utf-8'))
            return
        super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    with ReusableTCPServer(('127.0.0.1', PORT), DevHandler) as httpd:
        print(f'Dev server listening on http://localhost:{PORT}')
        httpd.serve_forever()
