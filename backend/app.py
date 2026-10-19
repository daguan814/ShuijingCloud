import mimetypes
import os

from flask import Flask, g, jsonify, request, send_file
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.exceptions import RequestEntityTooLarge

from .auth_service import auth_service
from .config import ALLOWED_ORIGINS, APP_HOST, APP_PORT, KK_PREVIEW_MAX_AGE, MAX_CONTENT_LENGTH, SECRET_KEY
from .database import db_manager
from .file_service import file_service
from .admin_file_service import admin_file_service
from .routes.auth import auth_bp
from .routes.files import files_bp
from .routes.admin import admin_bp


def _token_from_request():
    authorization = request.headers.get("Authorization", "")
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return ""


def _add_cors_headers(response):
    origin = request.headers.get("Origin")
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
    response.headers["Vary"] = "Origin"
    return response


def create_app():
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
    app.config["SECRET_KEY"] = SECRET_KEY
    if SECRET_KEY == "shuijing-cloud-preview-secret-change-me" and os.getenv("FLASK_DEBUG", "0") != "1":
        raise RuntimeError("SECRET_KEY must be configured")
    app.kk_preview_serializer = URLSafeTimedSerializer(
        app.config["SECRET_KEY"], salt="shuijing-kkfileview-preview"
    )
    app.download_serializer = URLSafeTimedSerializer(
        app.config["SECRET_KEY"], salt="shuijing-file-download"
    )
    app.admin_serializer = URLSafeTimedSerializer(
        app.config["SECRET_KEY"], salt="shuijing-admin"
    )

    app.register_blueprint(auth_bp)
    app.register_blueprint(files_bp)
    app.register_blueprint(admin_bp)

    try:
        db_manager.init_db()
    except Exception as exc:
        print(f"Database initialization skipped: {exc}")

    @app.before_request
    def before_request():
        if request.method == "OPTIONS":
            response = app.response_class(status=204)
            return _add_cors_headers(response)

        if not request.path.startswith("/api"):
            return None

        if request.path in ("/api/health", "/api/auth/login", "/api/auth/classes", "/api/auth/register") or request.path.startswith("/api/admin/") or request.path.startswith("/api/preview-source/") or request.path.startswith(
            "/api/files/download/ticket/"
        ) or request.path.startswith("/api/auth/shared-files/download/ticket/"):
            return None

        token = _token_from_request()
        user = auth_service.get_user_by_token(token)
        if not user:
            return jsonify({"detail": "unauthorized"}), 401
        g.current_user = user
        return None

    @app.after_request
    def after_request(response):
        return _add_cors_headers(response)

    @app.errorhandler(RequestEntityTooLarge)
    def handle_too_large(_error):
        return jsonify({"detail": "upload is too large"}), 413

    @app.errorhandler(404)
    def handle_not_found(_error):
        return jsonify({"detail": "not found"}), 404

    @app.errorhandler(500)
    def handle_server_error(_error):
        return jsonify({"detail": "internal server error"}), 500

    @app.route("/api/health", methods=["GET"])
    def health():
        return jsonify({"ok": True})

    @app.route("/api/preview-source/<ticket>/<path:filename>", methods=["GET"])
    def serve_kk_preview_source(ticket: str, filename: str):
        """Serve exactly one file to kkFileView using a short-lived ticket."""
        try:
            payload = app.kk_preview_serializer.loads(ticket, max_age=KK_PREVIEW_MAX_AGE)
            kind = payload.get("kind")
            if kind == "student":
                user = db_manager.find_user_by_id(int(payload["user_id"]))
                target = file_service.download_target(user, payload["path"]) if user else None
            elif kind == "admin":
                target = admin_file_service.target(int(payload["admin_id"]), payload["path"])
            else:
                target = None
        except (BadSignature, SignatureExpired, KeyError, TypeError, ValueError, FileNotFoundError):
            target = None

        if not target or not target.exists() or not target.is_file() or target.is_symlink():
            return jsonify({"detail": "preview file not found or expired"}), 404

        mimetype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return send_file(target, as_attachment=False, download_name=target.name, mimetype=mimetype)

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(
        host=APP_HOST,
        port=APP_PORT,
        debug=os.getenv("FLASK_DEBUG", "0") == "1",
        threaded=True,
    )
