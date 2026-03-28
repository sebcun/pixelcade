from pathlib import Path

from flask import Flask
from flask_migrate import Migrate

from app.blueprints.auth import api_auth_bp, auth_bp
from app.blueprints.avatar import avatar_bp
from app.blueprints.develop import develop_bp
from app.blueprints.games import games_bp
from app.blueprints.main import main_bp
from app.blueprints.profile import profile_bp
from app.extensions import bcrypt, db, limiter

migrate = Migrate()


def create_app() -> Flask:
    root = Path(__file__).resolve().parent.parent
    app = Flask(
        __name__,
        template_folder=str(root / "templates"),
        static_folder=str(root / "static"),
    )

    db_path = (root / "pixelcade.db").resolve()
    app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{db_path.as_posix()}"
    app.config.setdefault("RATELIMIT_STORAGE_URI", "memory://")

    db.init_app(app)
    bcrypt.init_app(app)
    limiter.init_app(app)
    migrate.init_app(app, db)

    from . import models  # noqa: F401

    app.register_blueprint(auth_bp, url_prefix="/auth")
    app.register_blueprint(api_auth_bp, url_prefix="/api/auth")
    app.register_blueprint(develop_bp, url_prefix="/develop")
    app.register_blueprint(games_bp, url_prefix="/games")
    app.register_blueprint(profile_bp, url_prefix="/profile")
    app.register_blueprint(avatar_bp, url_prefix="/avatar")
    app.register_blueprint(main_bp)

    return app
