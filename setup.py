from setuptools import setup, find_packages

with open("requirements.txt") as f:
	install_requires = f.read().strip().split("\n")

from pathlib import Path
long_description = (Path(__file__).parent / "README.md").read_text()

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
