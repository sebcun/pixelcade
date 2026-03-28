import hmac

from flask import jsonify, redirect, request, url_for
from flask_bcrypt import Bcrypt
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_login import LoginManager
from flask_sqlalchemy import SQLAlchemy
from flask_wtf import CSRFProtect
from flask_wtf.csrf import generate_csrf

db = SQLAlchemy()
bcrypt = Bcrypt()
limiter = Limiter(key_func=get_remote_address)
login_manager = LoginManager()
csrf = CSRFProtect()


def _api_csrf_header_guard():
    if request.method == "GET":
        return None
    token = request.headers.get("X-CSRFToken", "")
    expected = generate_csrf()
    if not token or len(token) != len(expected) or not hmac.compare_digest(
        token, expected
    ):
        return jsonify({"error": "CSRF token missing or invalid"}), 403


def protect_api_blueprint(blueprint):
    csrf.exempt(blueprint)
    blueprint.before_request(_api_csrf_header_guard)


@login_manager.user_loader
def load_user(user_id):
    from app.models import User

    if user_id is None:
        return None
    try:
        pk = int(user_id)
    except (TypeError, ValueError):
        return None
    return db.session.get(User, pk)


@login_manager.unauthorized_handler
def _unauthorized():
    if request.path.startswith("/api/"):
        return jsonify({"error": "Authentication required"}), 401
    return redirect(url_for("auth.login", next=request.url))
