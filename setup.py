from setuptools import setup, find_packages

from pathlib import Path

_req = Path("requirements.txt").read_text().strip()
install_requires = [r for r in _req.splitlines() if r and not r.startswith("#")]

_readme = Path(__file__).parent / "README.md"
long_description = _readme.read_text(encoding="utf-8") if _readme.exists() else ""

setup(
	name="sigos",
	version="0.0.1",
	description="Sistema Integrado de Gestão Operacional de Segurança",
	long_description=long_description,
	long_description_content_type="text/markdown",
	author="Dércio Bobo",
	author_email="derciobob@gmail.com",
	packages=find_packages(),
	zip_safe=False,
	include_package_data=True,
	install_requires=install_requires,
)
