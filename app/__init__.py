from pathlib import Path

from flask import Flask

from app.blueprints.auth import auth_bp
from app.blueprints.avatar import avatar_bp
from app.blueprints.develop import develop_bp
from app.blueprints.games import games_bp
from app.blueprints.main import main_bp
from app.blueprints.profile import profile_bp


def create_app() -> Flask:
    root = Path(__file__).resolve().parent.parent
    app = Flask(
        __name__,
        template_folder=str(root / "templates"),
        static_folder=str(root / "static"),
    )

    app.register_blueprint(auth_bp, url_prefix="/auth")
    app.register_blueprint(develop_bp, url_prefix="/develop")
    app.register_blueprint(games_bp, url_prefix="/games")
    app.register_blueprint(profile_bp, url_prefix="/profile")
    app.register_blueprint(avatar_bp, url_prefix="/avatar")
    app.register_blueprint(main_bp)

    return app
