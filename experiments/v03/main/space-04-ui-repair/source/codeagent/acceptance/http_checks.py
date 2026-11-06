"""Protected black-box checks. No imports from generated project source."""
import concurrent.futures
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from ..provider import Cancelled


class HTTP:
    def __init__(self, session):
        self.session = session
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.checks = []

    def request(self, method, path, token=None, body=None, *, origin=None, form=False):
        if self.session.cancel.is_set():
            raise Cancelled("运行检查已取消")
        headers = {"Content-Type": "application/x-www-form-urlencoded" if form else "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        data = (urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()) if body is not None else None
        req = urllib.request.Request((origin or self.session.base) + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=10) as response:
                raw = response.read(1_000_000)
                try:
                    content = json.loads(raw) if raw else {}
                except ValueError:
                    content = {"text": raw.decode(errors="replace")[:500]}
                return response.status, content
        except urllib.error.HTTPError as exc:
            return exc.code, {}  # never serialize credentials, URLs or response token payloads

    def check(self, name, condition, **observed):
        self.checks.append({"check": name, "status": "passed" if condition else "failed", **observed})
        if not condition:
            raise AssertionError(name + (": " + json.dumps(observed) if observed else ""))

    def wait(self, operation, predicate=lambda r: r[0] == 200, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.session.cancel.is_set():
                raise Cancelled("运行检查已取消")
            try:
                result = operation()
                if predicate(result):
                    return result
            except (OSError, ValueError):
                pass
            self.session.cancel.wait(0.5)
        raise TimeoutError("服务未在时限内就绪")


def space_fractions(http):
    session = http.session
    identity = f"http://localhost:{session.oidc_port}"
    token_path = "/realms/space-fractions/protocol/openid-connect/token"

    def login(name):
        status, data = http.request("POST", token_path, body={"grant_type": "password", "client_id": "space-fractions-client",
                                   "username": name, "password": name, "scope": "openid"}, origin=identity, form=True)
        http.check("OIDC fixture login: " + name, status == 200 and bool(data.get("access_token")), http_status=status)
        return data["access_token"]

    http.wait(lambda: http.request("GET", "/realms/space-fractions/.well-known/openid-configuration", origin=identity))
    status, master = http.request("POST", "/realms/master/protocol/openid-connect/token", origin=identity, form=True,
                                 body={"grant_type": "password", "client_id": "admin-cli", "username": "admin", "password": "admin"})
    http.check("local identity-provider fixture admin", status == 200, http_status=status)
    status, clients = http.request("GET", "/admin/realms/space-fractions/clients?clientId=space-fractions-client",
                                   master["access_token"], origin=identity)
    http.check("browser client is public and requires S256", status == 200 and bool(clients) and clients[0].get("publicClient") is True
               and clients[0].get("attributes", {}).get("pkce.code.challenge.method") == "S256")
    client = clients[0]
    # Deployment-origin adaptation only. Never repair roles, business data or a confidential client here.
    client["redirectUris"] = [session.base + "/*"]
    client["webOrigins"] = [session.base]
    client.setdefault("attributes", {})["post.logout.redirect.uris"] = session.base + "/*"
    status, _ = http.request("PUT", "/admin/realms/space-fractions/clients/" + client["id"], master["access_token"], client, origin=identity)
    http.check("temporary public callback origin configured", status == 204, http_status=status)
    user, admin, other = login("student"), login("admin"), login("other")
    status, _ = http.request("POST", "/api/games", body={})
    http.check("missing authentication rejected", status == 401, http_status=status)
    forged = user.rsplit(".", 1)[0] + ".invalid-signature"
    status, _ = http.request("POST", "/api/games", forged, {})
    http.check("wrong signature rejected", status == 401, http_status=status)
    fixture = {"prompt": "Independent nebula: 1/2 + 1/4?", "options": ["3/4", "1/4"], "correctAnswer": "3/4"}
    status, _ = http.request("POST", "/api/admin/questions", user, fixture)
    http.check("ordinary user denied administration", status == 403, http_status=status)
    created = []
    try:
        for index in range(2):
            status, q = http.request("POST", "/api/admin/questions", admin, {**fixture, "prompt": fixture["prompt"] + str(index)})
            http.check("admin creates practice question " + str(index), status == 201 and bool(q.get("id")), http_status=status)
            created.append(q["id"])
        status, game = http.request("POST", "/api/games", user, {"questionIds": created})
        http.check("authenticated game creation", status == 201 and bool(game.get("id")), http_status=status)
        http.check("player questions hide correct answers", len(game.get("questions", [])) == 2 and "correctAnswer" not in json.dumps(game)
                   and "correct_answer" not in json.dumps(game))
        endpoint = "/api/games/" + str(game["id"])
        status, _ = http.request("GET", endpoint, other)
        http.check("cross-user ownership enforced", status in (403, 404), http_status=status)
        status, _ = http.request("POST", endpoint + "/pause", user, {})
        http.check("pause", status == 200, http_status=status)
        answer = {"questionId": created[0], "answer": "6/8"}
        status, _ = http.request("POST", endpoint + "/answers", user, answer)
        http.check("paused answer rejected", status == 409, http_status=status)
        status, _ = http.request("POST", endpoint + "/resume", user, {})
        http.check("resume", status == 200, http_status=status)
        status, _ = http.request("POST", endpoint + "/answers", user, {**answer, "answer": "1/0"})
        http.check("invalid fraction rejected", status == 400, http_status=status)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: http.request("POST", endpoint + "/answers", user, answer), range(8)))
        status, score = http.request("GET", endpoint + "/score", user)
        http.check("eight concurrent equivalent answers score once", status == 200 and score.get("score") == 1
                   and all(s in (200, 409) for s, _ in results), score=score.get("score"), statuses=[s for s, _ in results])
        session.restart()
        status, score = http.wait(lambda: http.request("GET", endpoint + "/score", user))
        http.check("score persists across application restart", score.get("score") == 1, score=score.get("score"))
        status, result = http.request("POST", endpoint + "/answers", user, {"questionId": created[1], "answer": "3/4"})
        http.check("second question increments score", status == 200 and result.get("score") == 2 and result.get("correct") is True,
                   http_status=status, score=result.get("score"))
        status, _ = http.request("POST", endpoint + "/answers", user, {"questionId": created[1], "answer": "3/4"})
        http.check("completed duplicate safely handled", status in (200, 409), http_status=status)
        status, final = http.request("GET", endpoint + "/score", user)
        http.check("completed score remains two", status == 200 and final.get("score") == 2)
    finally:
        for qid in created:
            status, _ = http.request("DELETE", "/api/admin/questions/" + str(qid), admin)
            http.check("practice question cleanup", status in (200, 204), http_status=status)


def library(http):
    status, _ = http.request("POST", "/api/books", body={"title": "Invalid copies", "copies": 0})
    http.check("invalid book copies rejected", status == 400, http_status=status)
    status, book = http.request("POST", "/api/books", body={"title": "Independent acceptance book", "copies": 1})
    http.check("create book with one available copy", status == 201 and bool(book.get("id")) and book.get("availableCopies") == 1,
               http_status=status)
    book_path = "/api/books/" + str(book["id"])
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        attempts = list(pool.map(lambda i: http.request("POST", "/api/loans", body={"bookId": book["id"], "userId": "reader-" + str(i)}), range(8)))
    successes = [data for status, data in attempts if status == 201]
    http.check("concurrent borrowers cannot oversell", len(successes) == 1 and all(s in (201, 409) for s, _ in attempts),
               statuses=[s for s, _ in attempts])
    loan = successes[0]
    status, current = http.request("GET", book_path)
    http.check("stock after borrowing is zero", status == 200 and current.get("availableCopies") == 0)
    return_path = "/api/loans/" + str(loan["id"]) + "/return"
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        returns = list(pool.map(lambda _: http.request("POST", return_path, body={}), range(8)))
    status, current = http.request("GET", book_path)
    http.check("concurrent duplicate returns restore exactly one copy", status == 200 and current.get("availableCopies") == 1
               and all(s == 200 for s, _ in returns), statuses=[s for s, _ in returns])
    status, loan = http.request("POST", "/api/loans", body={"bookId": book["id"], "userId": "persistent-reader"})
    http.check("borrow returned copy", status == 201, http_status=status)
    status, _ = http.request("POST", "/api/loans", body={"bookId": book["id"], "userId": "persistent-reader"})
    http.check("active duplicate rejected", status == 409, http_status=status)
    http.session.restart()
    status, current = http.wait(lambda: http.request("GET", book_path))
    http.check("book inventory persists after restart", current.get("availableCopies") == 0)
    status, _ = http.request("POST", "/api/loans/" + str(loan["id"]) + "/return", body={})
    http.check("loan persists and can be returned after restart", status == 200, http_status=status)
    status, current = http.request("GET", book_path)
    http.check("persisted loan returns one copy", status == 200 and current.get("availableCopies") == 1)


def exercise(session, profile):
    http = HTTP(session)
    try:
        http.wait(lambda: http.request("GET", "/health"), timeout=180)
        http.check("gateway ready", True)
        status, _ = http.request("GET", "/")
        http.check("browser entry served", status == 200, http_status=status)
        {"space-fractions": space_fractions, "library": library}[profile](http)
        return {"status": "passed", "checks": http.checks}
    except Cancelled:
        raise
    except Exception as exc:
        return {"status": "failed", "checks": http.checks, "error": type(exc).__name__ + ": " + str(exc)}
